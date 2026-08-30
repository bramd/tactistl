use crate::vec::{Bbox3, Vec3};

#[derive(Debug, Clone, Copy)]
pub struct Triangle {
    pub v: [Vec3; 3],
}

#[derive(Debug, Clone, Default)]
pub struct Mesh {
    pub triangles: Vec<Triangle>,
}

#[derive(Debug)]
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
    if bytes.len() < 84 {
        return None;
    }
    let n = u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as usize;
    // Guard the multiply: n comes straight from the file and is untrusted.
    let exact = n.checked_mul(50).and_then(|b| b.checked_add(84)) == Some(bytes.len());
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
        let t = Triangle { v: [v(0), v(1), v(2)] };
        // Reject the whole file rather than skipping the offending triangles:
        // silently dropped geometry is worse than a clear refusal for a tool
        // whose purpose is trusting the output as a reading of the model.
        // Only the vertices are checked; `Triangle` does not keep the facet
        // normal, so a garbage normal cannot reach any downstream maths, and
        // real exporters do write junk there.
        if t.v.iter().any(|p| !(p.x.is_finite() && p.y.is_finite() && p.z.is_finite())) {
            return Err(ParseError::NonFinite);
        }
        triangles.push(t);
    }

    if triangles.is_empty() {
        return Err(ParseError::NoGeometry);
    }
    Ok(Mesh { triangles })
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
}
