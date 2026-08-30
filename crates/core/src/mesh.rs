use crate::vec::{Bbox3, Vec3};

#[derive(Debug, Clone, Copy)]
pub struct Triangle {
    pub v: [Vec3; 3],
}

#[derive(Debug, Clone, Default)]
pub struct Mesh {
    pub triangles: Vec<Triangle>,
}

#[derive(Debug, Clone)]
pub enum ParseError {
    /// The bytes are not a readable ASCII or binary STL. `detail` is the
    /// underlying technical message; it is kept out of `Display` on purpose,
    /// because that text is read aloud to the user by a screen reader.
    Malformed {
        kind: std::io::ErrorKind,
        detail: String,
    },
    /// Parsed successfully but contains no triangles.
    NoGeometry,
    /// A coordinate was NaN or an infinity. A binary STL can carry these
    /// legally, and they poison everything downstream: an infinity wrecks the
    /// framing box, while a NaN slips through `bounds()` unnoticed — `f32::min`
    /// and `f32::max` ignore a NaN operand — and only resurfaces as NaN
    /// cross-section coordinates, i.e. a blank or garbage tactile frame with no
    /// error to explain it.
    NonFinite,
}

impl ParseError {
    fn malformed(e: std::io::Error) -> Self {
        ParseError::Malformed {
            kind: e.kind(),
            detail: e.to_string(),
        }
    }
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::Malformed { kind, .. } => match kind {
                std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::InvalidData => {
                    write!(f, "this does not look like an STL file, or it is incomplete")
                }
                _ => write!(f, "this STL file could not be read"),
            },
            ParseError::NoGeometry => write!(f, "the file contains no triangles"),
            ParseError::NonFinite => write!(f, "this STL contains invalid coordinates"),
        }
    }
}

impl std::error::Error for ParseError {}

impl Mesh {
    pub fn bounds(&self) -> Bbox3 {
        let mut b = Bbox3::empty();
        for t in &self.triangles {
            for v in t.v {
                b.include(v);
            }
        }
        b
    }
}

/// The triangle count of a binary STL, **verified against the file length**.
///
/// A binary STL is exactly `84 + 50 * n` bytes, where `n` is the little-endian
/// `u32` triangle count at offset 80. That length check is the robust way to
/// tell the two formats apart — and, because the equality has to hold exactly,
/// it also turns the untrusted header count into a trustworthy one: `n` cannot
/// exceed `(bytes.len() - 84) / 50`, whatever the header claims.
///
/// `None` therefore means both "not a binary STL, treat it as ASCII" and "the
/// header count is worthless, do not allocate from it".
fn binary_triangle_count(bytes: &[u8]) -> Option<usize> {
    binary_triangle_count_for(bytes, bytes.len())
}

/// The same rule, for a caller that holds only the first 84 bytes but knows
/// the file's total length up front — the streaming parser.
///
/// Splitting it this way is deliberate: the equality check is the single thing
/// standing between an attacker-chosen `u32` and a multi-gigabyte
/// `reserve_exact`, so both callers must run the *same* comparison rather than
/// two that merely look alike.
///
/// For the streaming caller `total_len` is `File.size`, i.e. metadata from the
/// filesystem rather than a number the file's own bytes chose. It is trusted
/// exactly as far as the non-streaming caller trusts `bytes.len()`, and if it
/// turns out to be a lie the parser refuses the file at `finish` for having
/// delivered the wrong number of bytes.
fn binary_triangle_count_for(head: &[u8], total_len: usize) -> Option<usize> {
    if head.len() < 84 || total_len < 84 {
        return None;
    }
    let n = u32::from_le_bytes(head[80..84].try_into().unwrap()) as usize;
    // Guard the multiply: n comes straight from the file and is untrusted.
    let exact = n.checked_mul(50).and_then(|b| b.checked_add(84)) == Some(total_len);
    exact.then_some(n)
}

/// A `Read + Seek` view of `head` followed by `tail`, borrowing both.
///
/// This exists so `parse_stl` can rewrite the first few bytes of a file for
/// `stl_io`'s format probe without duplicating the file to do it. The obvious
/// version — clone the bytes, edit the clone — costs a second full copy of the
/// file inside WASM linear memory, which for a 300 MB STL is 300 MB that,
/// because wasm32 memory never shrinks, never comes back.
struct Patched<'a> {
    head: &'a [u8],
    tail: &'a [u8],
    pos: usize,
}

impl<'a> Patched<'a> {
    /// `head` stands in for whatever the caller sliced off the front of
    /// `tail`; pass an empty `head` to read `tail` unchanged.
    fn new(head: &'a [u8], tail: &'a [u8]) -> Self {
        Patched { head, tail, pos: 0 }
    }

    fn len(&self) -> usize {
        self.head.len() + self.tail.len()
    }

    /// Everything from virtual offset `i` to the end of whichever of the two
    /// slices `i` lands in; empty past the end.
    fn slice_from(&self, i: usize) -> &'a [u8] {
        if i < self.head.len() {
            &self.head[i..]
        } else {
            self.tail.get(i - self.head.len()..).unwrap_or(&[])
        }
    }
}

impl std::io::Read for Patched<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // A read spanning the head/tail boundary returns the head part only.
        // `Read` explicitly permits a short read, and both `read_exact` and
        // `BufReader` handle it by looping.
        let src = self.slice_from(self.pos);
        let n = src.len().min(buf.len());
        buf[..n].copy_from_slice(&src[..n]);
        self.pos += n;
        Ok(n)
    }
}

impl std::io::Seek for Patched<'_> {
    fn seek(&mut self, from: std::io::SeekFrom) -> std::io::Result<u64> {
        use std::io::SeekFrom;
        let (base, delta) = match from {
            SeekFrom::Start(n) => {
                self.pos = usize::try_from(n).unwrap_or(usize::MAX);
                return Ok(self.pos as u64);
            }
            SeekFrom::End(d) => (self.len() as i64, d),
            SeekFrom::Current(d) => (self.pos as i64, d),
        };
        let target = base.checked_add(delta).filter(|t| *t >= 0).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "seek before start")
        })?;
        self.pos = target as usize;
        Ok(self.pos as u64)
    }
}

/// Parse an ASCII or binary STL.
///
/// We sniff the format ourselves rather than trusting `stl_io`, whose probe is
/// `first_line.starts_with("solid ")` — with a trailing space. That probe both
/// rejects a legal ASCII STL with an empty solid name (`solid\n`) and
/// misclassifies a binary STL whose ignored 80-byte header happens to begin
/// with `"solid "`, which several exporters write.
///
/// `stl_io` does not export its two readers (`ascii_reader` and `binary_reader`
/// are private modules), so we cannot dispatch to them directly. Instead we
/// hand `create_stl_reader` a `Patched` view that rewrites the first few bytes
/// in exactly the two cases its probe gets wrong; the common cases are passed
/// through untouched. `Patched` borrows, so none of this copies the file — a
/// full copy here was measured at +150 MB of peak WASM memory on a 150 MB STL
/// with a `"solid "` header, which is the one case a naive fix-up hits.
pub fn parse_stl(bytes: &[u8]) -> Result<Mesh, ParseError> {
    let exact = binary_triangle_count(bytes);
    let mut source = if exact.is_some() {
        if bytes.starts_with(b"solid ") {
            // Workaround: blank the first header bytes so the probe fails and
            // the binary reader is used. The 80-byte header is ignored by the
            // format, so this does not change the parsed geometry.
            Patched::new(b"      ", &bytes[6..])
        } else {
            Patched::new(b"", bytes)
        }
    } else if bytes.starts_with(b"solid") && matches!(bytes.get(5), None | Some(b'\n' | b'\r')) {
        // Workaround: an empty solid name (`solid\n`) is legal but fails the
        // upstream probe, so insert the space it insists on. The guard
        // requires a line terminator (or EOF) after `solid`, which is all a
        // real ASCII STL can have there: a binary header such as "solidworks"
        // must fall through untouched, since inserting a byte into binary data
        // shifts every offset and can fabricate plausible-looking geometry.
        Patched::new(b"solid ", &bytes[5..])
    } else {
        Patched::new(b"", bytes)
    };

    let reader = stl_io::create_stl_reader(&mut source).map_err(ParseError::malformed)?;

    let mut triangles = Vec::new();
    // Reserve from `binary_triangle_count`, and never from the raw header
    // count or from `size_hint()`: those are untrusted, and pre-allocating
    // from them is what made a malformed file abort the process trying to
    // allocate ~103 GB. What makes this safe is that a count is only returned
    // once `84 + 50 * n == bytes.len()` holds exactly, which bounds the
    // reserve at `0.72 * bytes.len()` — smaller than the input it came from.
    //
    // Worth the care: without it the vector doubles its way up, and at the
    // final doubling the old and new buffers are live at once. Measured on a
    // 300 MB binary STL (6M triangles), peak allocation during the parse drops
    // from 453 MB to 216 MB, and the mesh's resident size from 302 MB to
    // 216 MB — the exact reserve also removes the up-to-2x capacity slack that
    // doubling otherwise leaves allocated for the mesh's whole lifetime.
    //
    // An ASCII file gets no reserve: its triangle count is not knowable up
    // front, and at ~160 bytes of text per triangle the same mesh needs a far
    // larger file, so the vector is proportionally small either way.
    if let Some(n) = exact {
        triangles.reserve_exact(n);
    }
    for tri in reader {
        let tri = tri.map_err(ParseError::malformed)?;
        let v = |i: usize| {
            let p = tri.vertices[i];
            Vec3::new(p[0], p[1], p[2])
        };
        // `checked_triangle` rejects the whole file rather than skipping the
        // offending triangles: silently dropped geometry is worse than a clear
        // refusal for a tool whose purpose is trusting the output as a reading
        // of the model. Only the vertices are checked; `Triangle` does not keep
        // the facet normal, so a garbage normal cannot reach any downstream
        // maths, and real exporters do write junk there. The streaming parser
        // calls the same function, so the two cannot drift apart.
        triangles.push(checked_triangle([v(0), v(1), v(2)])?);
    }

    if triangles.is_empty() {
        return Err(ParseError::NoGeometry);
    }
    Ok(Mesh { triangles })
}

/// The fixed part of a binary STL: an 80-byte header plus the `u32` count.
const BINARY_HEADER_LEN: usize = 84;
/// One binary triangle record: a 3-float normal, three 3-float vertices, and a
/// 2-byte attribute count.
const BINARY_RECORD_LEN: usize = 50;

/// Reject the whole file if any vertex coordinate is not finite.
///
/// Shared by both parsers so they cannot drift. See `ParseError::NonFinite`
/// for why this is fatal rather than a skipped triangle: a NaN is *invisible*
/// downstream, because `f32::min`/`max` ignore a NaN operand and `bounds()`
/// therefore looks perfectly ordinary over garbage geometry.
fn checked_triangle(v: [Vec3; 3]) -> Result<Triangle, ParseError> {
    if v.iter().any(|p| !(p.x.is_finite() && p.y.is_finite() && p.z.is_finite())) {
        return Err(ParseError::NonFinite);
    }
    Ok(Triangle { v })
}

fn truncated() -> ParseError {
    // Displays as "this does not look like an STL file, or it is incomplete",
    // which is exactly the truth for a binary file that stopped early. No new
    // user-facing string is invented for it.
    ParseError::Malformed {
        kind: std::io::ErrorKind::UnexpectedEof,
        detail: "the STL ended before the triangles its header promised".into(),
    }
}

/// What a `StreamParser` is doing with the bytes it is being handed.
enum StreamState {
    /// Fewer than 84 bytes have arrived: not yet enough to tell the formats
    /// apart. At most 83 bytes are held here.
    Header(Vec<u8>),
    /// Binary, decided by the verified length rule. `pending` holds the
    /// fraction of a record carried over a chunk boundary — at most 49 bytes,
    /// so the buffer never grows with the file.
    Binary {
        remaining: usize,
        pending: Vec<u8>,
        triangles: Vec<Triangle>,
    },
    /// Anything that is not binary-by-length. The whole input is accumulated
    /// and handed to `parse_stl` at `finish`.
    ///
    /// **Known limitation, deliberately accepted:** the memory win of
    /// streaming does not apply to ASCII STLs — their peak is exactly what it
    /// was before. An ASCII STL cannot be parsed incrementally without
    /// reimplementing `stl_io`'s text reader, and it is not worth it: the same
    /// geometry costs roughly 5x more bytes as text, so nobody ships large
    /// ASCII STLs, and the files that actually cause an out-of-memory are
    /// binary.
    Ascii(Vec<u8>),
    /// A push already failed. The error is latched and re-reported, so a
    /// caller that ignores a `push` error can never obtain a partial mesh.
    Failed(ParseError),
}

/// A chunk-fed STL parser.
///
/// This exists to cut peak memory. `parse_stl` needs the whole file resident
/// as one `&[u8]`, which in the browser means the file exists twice over — the
/// JavaScript `ArrayBuffer`, plus wasm-bindgen's copy of it into WASM linear
/// memory — before a single triangle is read. Neither copy is ever returned to
/// the browser, because wasm32 memory only grows. Feeding chunks removes both:
/// the caller streams the `File` from disk and the only long-lived allocation
/// is the mesh itself.
///
/// The total length is required up front (`File.size`, which costs no reading)
/// and is what makes the format decision — and the exact `reserve_exact` —
/// possible from the first 84 bytes.
pub struct StreamParser {
    total_len: usize,
    received: usize,
    state: StreamState,
}

impl StreamParser {
    /// `total_len` is the file's size in bytes, known before any of it is read.
    pub fn new(total_len: usize) -> Self {
        StreamParser {
            total_len,
            received: 0,
            state: StreamState::Header(Vec::new()),
        }
    }

    /// Feed the next chunk. Chunks may be any size, including empty, and need
    /// not align with anything.
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), ParseError> {
        if let StreamState::Failed(e) = &self.state {
            return Err(e.clone());
        }
        match self.push_inner(chunk) {
            Ok(()) => Ok(()),
            Err(e) => {
                self.state = StreamState::Failed(e.clone());
                Err(e)
            }
        }
    }

    fn push_inner(&mut self, chunk: &[u8]) -> Result<(), ParseError> {
        self.received = self.received.saturating_add(chunk.len());
        if self.received > self.total_len {
            // The file is longer than it said it was. Refuse rather than parse
            // on: every safety property here rests on the declared length, so
            // once it is known to be wrong nothing derived from it holds.
            return Err(ParseError::Malformed {
                kind: std::io::ErrorKind::InvalidData,
                detail: "more bytes arrived than the file's length allows".into(),
            });
        }

        let mut rest = chunk;
        if let StreamState::Header(buf) = &mut self.state {
            let need = BINARY_HEADER_LEN - buf.len();
            let take = need.min(rest.len());
            buf.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if buf.len() < BINARY_HEADER_LEN {
                return Ok(());
            }
            self.state = match binary_triangle_count_for(buf, self.total_len) {
                Some(n) => StreamState::Binary {
                    remaining: n,
                    pending: Vec::with_capacity(BINARY_RECORD_LEN),
                    // The one allocation that matters, and the reason the
                    // length rule may not be weakened to an inequality: `n` is
                    // verified, not merely bounded, so this is exact and
                    // capped at 0.72x the file.
                    triangles: {
                        let mut v = Vec::new();
                        v.reserve_exact(n);
                        v
                    },
                },
                None => {
                    let mut all = std::mem::take(buf);
                    // Sized from the declared length, not from anything the
                    // file's own bytes claimed — and the buffer is going to
                    // reach exactly this size anyway, so this only removes the
                    // doubling slack rather than committing to anything new.
                    all.reserve(self.total_len.saturating_sub(all.len()));
                    StreamState::Ascii(all)
                }
            };
        }

        match &mut self.state {
            StreamState::Binary { remaining, pending, triangles } => {
                Self::consume_binary(rest, remaining, pending, triangles)
            }
            StreamState::Ascii(buf) => {
                buf.extend_from_slice(rest);
                Ok(())
            }
            // `Header` returned above; `Failed` was rejected by `push`.
            _ => Ok(()),
        }
    }

    /// Decode whole 50-byte records straight out of `chunk`, keeping only the
    /// ragged ends. `pending` is topped up first, then the chunk is walked in
    /// place, then whatever is left over (< 50 bytes) is stashed.
    fn consume_binary(
        mut chunk: &[u8],
        remaining: &mut usize,
        pending: &mut Vec<u8>,
        triangles: &mut Vec<Triangle>,
    ) -> Result<(), ParseError> {
        if !pending.is_empty() {
            let need = BINARY_RECORD_LEN - pending.len();
            let take = need.min(chunk.len());
            pending.extend_from_slice(&chunk[..take]);
            chunk = &chunk[take..];
            if pending.len() == BINARY_RECORD_LEN {
                let t = Self::decode_record(pending, remaining)?;
                triangles.push(t);
                pending.clear();
            }
        }
        while chunk.len() >= BINARY_RECORD_LEN {
            let (record, tail) = chunk.split_at(BINARY_RECORD_LEN);
            let t = Self::decode_record(record, remaining)?;
            triangles.push(t);
            chunk = tail;
        }
        pending.extend_from_slice(chunk);
        Ok(())
    }

    /// One 50-byte record: 12 bytes of facet normal, which is *ignored*
    /// because `Triangle` does not store it and real exporters write junk
    /// there; then 36 bytes of vertices; then 2 attribute bytes.
    fn decode_record(record: &[u8], remaining: &mut usize) -> Result<Triangle, ParseError> {
        if *remaining == 0 {
            return Err(ParseError::Malformed {
                kind: std::io::ErrorKind::InvalidData,
                detail: "more triangles than the header declared".into(),
            });
        }
        *remaining -= 1;
        let f = |i: usize| {
            let at = 12 + i * 4;
            f32::from_le_bytes(record[at..at + 4].try_into().unwrap())
        };
        checked_triangle([
            Vec3::new(f(0), f(1), f(2)),
            Vec3::new(f(3), f(4), f(5)),
            Vec3::new(f(6), f(7), f(8)),
        ])
    }

    /// Finish and take the mesh. Errors if the stream ended mid-record, short
    /// of the declared length, or short of the header's triangle count.
    pub fn finish(self) -> Result<Mesh, ParseError> {
        if let StreamState::Failed(e) = self.state {
            return Err(e);
        }
        if self.received != self.total_len {
            return Err(truncated());
        }
        match self.state {
            StreamState::Failed(e) => Err(e),
            StreamState::Header(buf) => {
                // Under 84 bytes in total, so it can never have been binary.
                // Hand it to the ASCII reader, which is where the empty file
                // and garbage cases get their existing errors.
                parse_stl(&buf)
            }
            StreamState::Ascii(buf) => parse_stl(&buf),
            StreamState::Binary { remaining, pending, triangles } => {
                if remaining != 0 || !pending.is_empty() {
                    return Err(truncated());
                }
                if triangles.is_empty() {
                    return Err(ParseError::NoGeometry);
                }
                Ok(Mesh { triangles })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASCII_CUBE: &[u8] = include_bytes!("../tests/fixtures/cube_ascii.stl");
    const BINARY_CUBE: &[u8] = include_bytes!("../tests/fixtures/cube_binary.stl");

    #[test]
    fn parses_ascii_stl() {
        let mesh = parse_stl(ASCII_CUBE).unwrap();
        assert_eq!(mesh.triangles.len(), 12);
    }

    #[test]
    fn ascii_cube_has_expected_bounds() {
        let mesh = parse_stl(ASCII_CUBE).unwrap();
        let b = mesh.bounds();
        assert_eq!(b.min, Vec3::new(-1.0, -1.0, -1.0));
        assert_eq!(b.max, Vec3::new(1.0, 1.0, 1.0));
    }

    #[test]
    fn rejects_garbage() {
        // Too short to be a binary STL header, not ASCII either.
        assert!(parse_stl(b"not an stl file").is_err());
    }

    #[test]
    fn rejects_empty_mesh() {
        let empty = b"solid empty\nendsolid empty\n";
        let err = parse_stl(empty).unwrap_err();
        assert!(matches!(err, ParseError::NoGeometry));
    }

    #[test]
    fn parses_binary_stl() {
        let mesh = parse_stl(BINARY_CUBE).unwrap();
        assert_eq!(mesh.triangles.len(), 12);
        let b = mesh.bounds();
        assert_eq!(b.min, Vec3::new(-1.0, -1.0, -1.0));
    }

    #[test]
    fn parses_ascii_stl_with_empty_solid_name() {
        // Legal ASCII STL: `solid` with no name. Upstream's probe wants a
        // trailing space and would misroute this to the binary reader.
        let s = String::from_utf8(ASCII_CUBE.to_vec()).unwrap();
        let bare = s.replacen("solid cube\n", "solid\n", 1);
        assert!(bare.starts_with("solid\n"));
        let mesh = parse_stl(bare.as_bytes()).unwrap();
        assert_eq!(mesh.triangles.len(), 12);
    }

    #[test]
    fn parses_binary_stl_with_solid_header() {
        // Some exporters write "solid " into the (ignored) 80-byte header.
        let mut b = BINARY_CUBE.to_vec();
        b[..6].copy_from_slice(b"solid ");
        let mesh = parse_stl(&b).unwrap();
        assert_eq!(mesh.triangles.len(), 12);
        assert_eq!(mesh.bounds().min, Vec3::new(-1.0, -1.0, -1.0));
    }

    #[test]
    fn malformed_message_is_human_readable() {
        let err = parse_stl(b"not an stl file").unwrap_err();
        let msg = err.to_string();
        assert!(!msg.contains("buffer"), "leaked io::Error detail: {msg}");
        assert!(msg.contains("STL"), "unhelpful message: {msg}");
    }

    /// A binary STL with trailing padding fails the exact-length check, so it
    /// reaches the ASCII branch. Its 80-byte header may well start with the
    /// letters `solid` (e.g. "solidworks"); we must not treat that as ASCII
    /// and shift every byte by one, which would invent plausible-looking
    /// geometry from a file we cannot actually read.
    #[test]
    fn parses_padded_binary_stl_with_solidworks_header() {
        let mut b = BINARY_CUBE.to_vec();
        b[..10].copy_from_slice(b"solidworks");
        b.extend_from_slice(&[0u8; 4]);
        let mesh = parse_stl(&b).unwrap();
        assert_eq!(mesh.triangles.len(), 12);
        assert_eq!(mesh.bounds().min, Vec3::new(-1.0, -1.0, -1.0));
        assert_eq!(mesh.bounds().max, Vec3::new(1.0, 1.0, 1.0));
    }

    /// Overwrite one f32 of the binary fixture at `offset` with `v`.
    ///
    /// Binary STL layout: an 80-byte header, a u32 count, then 50 bytes per
    /// triangle (a 3-float normal, three 3-float vertices, a u16 attribute).
    fn poke_float(offset: usize, v: f32) -> Vec<u8> {
        let mut b = BINARY_CUBE.to_vec();
        b[offset..offset + 4].copy_from_slice(&v.to_le_bytes());
        b
    }

    /// The X of the first triangle's first vertex: 80 + 4 + 12.
    const FIRST_VERTEX_X: usize = 96;
    /// The Z of the last triangle's last vertex: 84 + 50*11 + 12 + 24 + 8.
    const LAST_VERTEX_Z: usize = 678;

    /// A binary STL can legally carry NaN in its f32 coordinates. Left alone,
    /// NaN is *invisible* downstream: `bounds()` uses `f32::min`/`max`, which
    /// ignore a NaN operand, so the framing box still looks perfectly ordinary
    /// while the geometry it frames is garbage. The user would get a blank or
    /// nonsense tactile frame and no error at all. Refuse the file instead.
    #[test]
    fn rejects_nan_coordinate() {
        let err = parse_stl(&poke_float(FIRST_VERTEX_X, f32::NAN)).unwrap_err();
        assert!(matches!(err, ParseError::NonFinite), "got {err:?}");
    }

    /// As above for an infinity, which poisons the bounds outright. Poking the
    /// *last* vertex's Z also pins that every vertex and every component is
    /// checked, not just the first one.
    #[test]
    fn rejects_infinite_coordinate() {
        let err = parse_stl(&poke_float(LAST_VERTEX_Z, f32::INFINITY)).unwrap_err();
        assert!(matches!(err, ParseError::NonFinite), "got {err:?}");
        let err = parse_stl(&poke_float(LAST_VERTEX_Z, f32::NEG_INFINITY)).unwrap_err();
        assert!(matches!(err, ParseError::NonFinite), "got {err:?}");
    }

    /// The whole file is refused rather than the bad triangles being skipped:
    /// silently dropped geometry is worse than a clear refusal for a tool whose
    /// entire purpose is trusting the output as an accurate reading.
    #[test]
    fn a_single_bad_coordinate_rejects_the_whole_file() {
        assert!(parse_stl(&poke_float(LAST_VERTEX_Z, f32::NAN)).is_err());
    }

    /// This string is read aloud to a blind user by a screen reader, so it must
    /// carry no float jargon.
    #[test]
    fn non_finite_message_is_human_readable() {
        let err = parse_stl(&poke_float(FIRST_VERTEX_X, f32::NAN)).unwrap_err();
        let msg = err.to_string();
        for jargon in ["NaN", "nan", "inf", "finite"] {
            assert!(!msg.contains(jargon), "leaked jargon {jargon:?}: {msg}");
        }
        assert!(msg.contains("STL"), "unhelpful message: {msg}");
    }

    /// The other non-finite tests all poke the *binary* fixture. An ASCII STL
    /// can carry a `nan` token too, and it is not obvious whether `stl_io`'s
    /// ASCII reader parses it into a float (so our own guard catches it) or
    /// rejects the token first. Empirically it is the latter: the reader
    /// refuses the token with `InvalidData`, so the file surfaces as
    /// `Malformed`, never reaching the `NonFinite` guard. That is fine — both
    /// are a clear refusal — but it means the `NonFinite` path is binary-only,
    /// and this test is what would notice if a future `stl_io` relaxed the
    /// token check and started letting NaN through.
    #[test]
    fn rejects_nan_coordinate_in_ascii_stl() {
        let src = "solid nan\n\
                   facet normal 0 0 1\n\
                   outer loop\n\
                   vertex nan 0 0\n\
                   vertex 1 0 0\n\
                   vertex 0 1 0\n\
                   endloop\n\
                   endfacet\n\
                   endsolid nan\n";
        let err = parse_stl(src.as_bytes()).unwrap_err();
        assert!(
            matches!(
                err,
                ParseError::Malformed { kind: std::io::ErrorKind::InvalidData, .. }
                    | ParseError::NonFinite
            ),
            "a NaN coordinate must be refused, got {err:?}"
        );
    }

    /// The hard-won invariant, pinned directly: a header claiming a colossal
    /// triangle count must never reach an allocation. The length check is what
    /// enforces it — `84 + 50 * n` cannot equal a small file's length — so
    /// `binary_triangle_count` returns `None` and no reserve happens. Asserted
    /// on the function rather than on `parse_stl`, because the failure mode
    /// this guards is an abort, which a test cannot catch.
    #[test]
    fn a_lying_triangle_count_yields_no_capacity_to_reserve() {
        let mut b = BINARY_CUBE.to_vec();
        // ~3 billion triangles: 103 GB if it were ever believed.
        b[80..84].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(binary_triangle_count(&b), None);
    }

    /// And the other half: a count that *does* match the length is exact, so
    /// reserving it is bounded by the input.
    #[test]
    fn a_length_checked_triangle_count_is_exact_and_bounded() {
        let n = binary_triangle_count(BINARY_CUBE).unwrap();
        assert_eq!(n, 12);
        assert!(n * std::mem::size_of::<Triangle>() < BINARY_CUBE.len());
    }

    /// The mesh must come out with no capacity slack on the binary path: that
    /// slack is up to 2x the mesh, held for as long as the model is loaded,
    /// and on wasm32 it is never returned to the browser.
    #[test]
    fn a_binary_stl_allocates_no_spare_triangle_capacity() {
        let mesh = parse_stl(BINARY_CUBE).unwrap();
        assert_eq!(mesh.triangles.capacity(), mesh.triangles.len());
    }

    /// `Patched` is what lets the two probe workarounds avoid copying the
    /// file. It must read as the concatenation of its two halves across the
    /// boundary, and rewind, because `stl_io`'s probe reads a line and seeks
    /// back to zero before the real reader starts.
    #[test]
    fn patched_reads_head_then_tail_and_rewinds() {
        use std::io::{Read, Seek, SeekFrom};
        let tail = b"world";
        let mut p = Patched::new(b"hello ", tail);
        let mut s = String::new();
        p.read_to_string(&mut s).unwrap();
        assert_eq!(s, "hello world");
        p.seek(SeekFrom::Start(0)).unwrap();
        s.clear();
        p.read_to_string(&mut s).unwrap();
        assert_eq!(s, "hello world", "a second pass after rewinding differed");
        // A read landing inside the tail must not re-serve the head.
        p.seek(SeekFrom::Start(8)).unwrap();
        s.clear();
        p.read_to_string(&mut s).unwrap();
        assert_eq!(s, "rld");
    }

    /// Regression: poking a float must not itself break the fixture, so the
    /// same helper writing a *finite* value still parses.
    #[test]
    fn poking_a_finite_value_still_parses() {
        let mesh = parse_stl(&poke_float(FIRST_VERTEX_X, 0.5)).unwrap();
        assert_eq!(mesh.triangles.len(), 12);
    }

    // --- the streaming parser -------------------------------------------
    //
    // The property that matters is *equivalence*: whatever `parse_stl` makes
    // of a byte string, `StreamParser` must make of the same byte string, at
    // any chunking. Nearly every test below is written as that comparison
    // rather than against hand-written expectations, because a streaming
    // parser that merely produces "a plausible mesh" is exactly the bug this
    // could ship.

    /// Feed `bytes` through a `StreamParser` in `chunk` sized pieces.
    fn stream_in(bytes: &[u8], chunk: usize) -> Result<Mesh, ParseError> {
        let mut p = StreamParser::new(bytes.len());
        for part in bytes.chunks(chunk.max(1)) {
            p.push(part)?;
        }
        p.finish()
    }

    fn same_mesh(a: &Mesh, b: &Mesh) -> bool {
        a.triangles.len() == b.triangles.len()
            && a.triangles.iter().zip(&b.triangles).all(|(x, y)| {
                x.v.iter()
                    .zip(y.v.iter())
                    .all(|(p, q)| p.x == q.x && p.y == q.y && p.z == q.z)
            })
    }

    /// Assert that streaming at `chunk` agrees with `parse_stl` exactly,
    /// including on the error path: an error in one must be an error in the
    /// other, with the same `Display` text (that text is read aloud).
    fn assert_agrees(bytes: &[u8], chunk: usize) {
        match (parse_stl(bytes), stream_in(bytes, chunk)) {
            (Ok(whole), Ok(streamed)) => assert!(
                same_mesh(&whole, &streamed),
                "chunk {chunk}: streamed mesh differs from the whole-file parse"
            ),
            (Err(a), Err(b)) => assert_eq!(
                a.to_string(),
                b.to_string(),
                "chunk {chunk}: the two parsers refused the file differently"
            ),
            (a, b) => panic!("chunk {chunk}: one parser succeeded and the other did not: {a:?} / {b:?}"),
        }
    }

    #[test]
    fn streaming_a_binary_stl_matches_the_whole_file_parse() {
        for chunk in [1, 7, 49, 50, 51, 83, 84, 85, 128, 1024, BINARY_CUBE.len()] {
            assert_agrees(BINARY_CUBE, chunk);
        }
    }

    /// A byte at a time is the worst case for every boundary at once: the
    /// header decision, every record split, and the final record's end.
    #[test]
    fn a_single_byte_at_a_time_produces_the_same_mesh() {
        let whole = parse_stl(BINARY_CUBE).unwrap();
        let streamed = stream_in(BINARY_CUBE, 1).unwrap();
        assert_eq!(streamed.triangles.len(), 12);
        assert!(same_mesh(&whole, &streamed));
        assert_eq!(streamed.bounds().min, Vec3::new(-1.0, -1.0, -1.0));
        assert_eq!(streamed.bounds().max, Vec3::new(1.0, 1.0, 1.0));
    }

    /// The format decision needs 84 bytes; make the chunk boundary land in the
    /// middle of the `u32` count itself, which is the byte range the decision
    /// actually reads.
    #[test]
    fn the_format_is_decided_across_a_chunk_boundary() {
        for split in [0, 1, 79, 80, 81, 82, 83, 84, 85] {
            let mut p = StreamParser::new(BINARY_CUBE.len());
            p.push(&BINARY_CUBE[..split]).unwrap();
            p.push(&BINARY_CUBE[split..]).unwrap();
            let mesh = p.finish().unwrap();
            assert_eq!(mesh.triangles.len(), 12, "split at {split}");
        }
    }

    /// A record split across a boundary must be carried, not dropped or
    /// re-read. Split inside the *vertices* of the second record, where a
    /// mis-carry would silently shift every later coordinate.
    #[test]
    fn a_record_split_across_chunks_is_carried_correctly() {
        let whole = parse_stl(BINARY_CUBE).unwrap();
        for split in [84 + 25, 84 + 50 + 20, 84 + 50 * 11 + 30] {
            let mut p = StreamParser::new(BINARY_CUBE.len());
            p.push(&BINARY_CUBE[..split]).unwrap();
            p.push(&BINARY_CUBE[split..]).unwrap();
            let mesh = p.finish().unwrap();
            assert!(same_mesh(&whole, &mesh), "split at {split}");
        }
    }

    /// The streamed mesh must carry no capacity slack either: on wasm32 that
    /// slack is never handed back to the browser.
    #[test]
    fn a_streamed_binary_stl_allocates_no_spare_triangle_capacity() {
        let mesh = stream_in(BINARY_CUBE, 997).unwrap();
        assert_eq!(mesh.triangles.capacity(), mesh.triangles.len());
    }

    /// The stream stopped early. `File.size` said one thing and the bytes said
    /// another, so there is no mesh to hand back — the tail triangles would
    /// simply be missing, which is exactly the silent corruption this tool
    /// cannot afford.
    #[test]
    fn a_truncated_binary_stl_is_refused() {
        let mut p = StreamParser::new(BINARY_CUBE.len());
        p.push(&BINARY_CUBE[..BINARY_CUBE.len() - 30]).unwrap();
        let err = p.finish().unwrap_err();
        assert_eq!(
            err.to_string(),
            "this does not look like an STL file, or it is incomplete"
        );
    }

    /// Truncated at an exact record boundary: the byte count is short but no
    /// record is half-decoded, so only the count check can catch it.
    #[test]
    fn a_binary_stl_short_by_whole_records_is_refused() {
        let mut p = StreamParser::new(BINARY_CUBE.len());
        p.push(&BINARY_CUBE[..84 + 50 * 9]).unwrap();
        assert!(p.finish().is_err());
    }

    /// The other direction: more bytes arrive than the declared length. Every
    /// safety property here rests on that length, so the file is refused
    /// rather than parsed on.
    #[test]
    fn more_bytes_than_declared_are_refused() {
        let mut p = StreamParser::new(BINARY_CUBE.len());
        p.push(BINARY_CUBE).unwrap();
        assert!(p.push(&[0u8; 8]).is_err());
    }

    /// A push failure is latched: a caller that ignores the error from `push`
    /// must not be able to get a partial mesh out of `finish`.
    #[test]
    fn a_failed_push_is_latched_and_finish_still_fails() {
        let mut b = BINARY_CUBE.to_vec();
        b[FIRST_VERTEX_X..FIRST_VERTEX_X + 4].copy_from_slice(&f32::NAN.to_le_bytes());
        let mut p = StreamParser::new(b.len());
        let mut errored = false;
        for part in b.chunks(64) {
            if p.push(part).is_err() {
                errored = true;
            }
        }
        assert!(errored, "the NaN was never reported");
        let err = p.finish().unwrap_err();
        assert!(matches!(err, ParseError::NonFinite), "got {err:?}");
    }

    /// The header's count and the file length disagree, so the length rule
    /// refuses to call it binary at all: the streaming parser reserves nothing
    /// from the count and falls back to buffering the file for `parse_stl`,
    /// which is free to make of it whatever the non-streaming path always did.
    /// What is pinned here is that the two still agree — the fallback must not
    /// be a second, subtly different reading of the same bytes.
    #[test]
    fn a_binary_header_whose_count_disagrees_with_the_length_is_not_streamed() {
        let mut b = BINARY_CUBE.to_vec();
        b[80..84].copy_from_slice(&11u32.to_le_bytes());
        assert_eq!(binary_triangle_count_for(&b[..84], b.len()), None);
        assert_agrees(&b, 64);
    }

    /// The invariant, at the streaming entry point: a header claiming billions
    /// of triangles must not drive an allocation. Asserted on the shared rule,
    /// because the failure it guards against is an abort, which no test can
    /// catch.
    #[test]
    fn a_lying_triangle_count_yields_no_capacity_to_reserve_when_streaming() {
        let mut b = BINARY_CUBE.to_vec();
        b[80..84].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(binary_triangle_count_for(&b[..84], b.len()), None);
        assert!(stream_in(&b, 64).is_err());
    }

    #[test]
    fn streaming_rejects_a_non_finite_coordinate() {
        for offset in [FIRST_VERTEX_X, LAST_VERTEX_Z] {
            for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
                let b = poke_float(offset, bad);
                let err = stream_in(&b, 37).unwrap_err();
                assert!(matches!(err, ParseError::NonFinite), "got {err:?}");
                assert_agrees(&b, 37);
            }
        }
    }

    /// ASCII still parses when streamed, via the accumulate-and-delegate
    /// fallback. Its peak memory is unchanged from before, which is the
    /// documented limitation.
    #[test]
    fn streaming_an_ascii_stl_matches_the_whole_file_parse() {
        for chunk in [1, 3, 84, 500] {
            let mesh = stream_in(ASCII_CUBE, chunk).unwrap();
            assert_eq!(mesh.triangles.len(), 12, "chunk {chunk}");
            assert_agrees(ASCII_CUBE, chunk);
        }
    }

    /// The awkward cases the format sniffing exists for must survive
    /// streaming too, because the decision is now made from 84 bytes plus a
    /// declared length rather than from the whole slice.
    #[test]
    fn streaming_handles_the_awkward_headers_the_same_way() {
        let bare = String::from_utf8(ASCII_CUBE.to_vec())
            .unwrap()
            .replacen("solid cube\n", "solid\n", 1);
        assert_agrees(bare.as_bytes(), 13);

        let mut solid_header = BINARY_CUBE.to_vec();
        solid_header[..6].copy_from_slice(b"solid ");
        assert_agrees(&solid_header, 13);
        assert_eq!(stream_in(&solid_header, 13).unwrap().triangles.len(), 12);

        let mut padded = BINARY_CUBE.to_vec();
        padded[..10].copy_from_slice(b"solidworks");
        padded.extend_from_slice(&[0u8; 4]);
        assert_agrees(&padded, 13);
        assert_eq!(stream_in(&padded, 13).unwrap().triangles.len(), 12);
    }

    /// The pre-existing refusals must read identically when streamed: these
    /// strings are announced to the user by a screen reader.
    #[test]
    fn streaming_refuses_the_empty_and_garbage_cases_as_before() {
        for bytes in [
            b"".as_slice(),
            b"not an stl file".as_slice(),
            b"solid empty\nendsolid empty\n".as_slice(),
        ] {
            assert!(stream_in(bytes, 4).is_err());
            assert_agrees(bytes, 4);
        }
        assert_eq!(
            stream_in(b"solid empty\nendsolid empty\n", 4)
                .unwrap_err()
                .to_string(),
            "the file contains no triangles"
        );
    }

    /// A zero-length push is legal and must change nothing — a `ReadableStream`
    /// is entitled to hand one over.
    #[test]
    fn empty_chunks_are_harmless() {
        let mut p = StreamParser::new(BINARY_CUBE.len());
        p.push(&[]).unwrap();
        for part in BINARY_CUBE.chunks(100) {
            p.push(&[]).unwrap();
            p.push(part).unwrap();
        }
        p.push(&[]).unwrap();
        assert_eq!(p.finish().unwrap().triangles.len(), 12);
    }
}
