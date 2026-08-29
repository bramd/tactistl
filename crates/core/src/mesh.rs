use crate::vec::{Bbox3, Vec3};
use std::io::Cursor;

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

/// A binary STL is exactly `84 + 50 * n` bytes, where `n` is the little-endian
/// `u32` triangle count at offset 80. That length check is the robust way to
/// tell the two formats apart.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.len() >= 84 && {
        let n = u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as usize;
        // Guard the multiply: n comes straight from the file and is untrusted.
        n.checked_mul(50).and_then(|b| b.checked_add(84)) == Some(bytes.len())
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
/// hand `create_stl_reader` a minimally normalised copy in exactly the two
/// cases its probe gets wrong; the common cases are passed through untouched.
pub fn parse_stl(bytes: &[u8]) -> Result<Mesh, ParseError> {
    let normalised: Vec<u8>;
    let bytes: &[u8] = if looks_binary(bytes) {
        if bytes.starts_with(b"solid ") {
            // Workaround: blank the first header bytes so the probe fails and
            // the binary reader is used. The 80-byte header is ignored by the
            // format, so this does not change the parsed geometry.
            let mut b = bytes.to_vec();
            b[..6].fill(b' ');
            normalised = b;
            &normalised
        } else {
            bytes
        }
    } else if bytes.starts_with(b"solid") && matches!(bytes.get(5), None | Some(b'\n' | b'\r')) {
        // Workaround: an empty solid name (`solid\n`) is legal but fails the
        // upstream probe, so insert the space it insists on. The guard
        // requires a line terminator (or EOF) after `solid`, which is all a
        // real ASCII STL can have there: a binary header such as "solidworks"
        // must fall through untouched, since inserting a byte into binary data
        // shifts every offset and can fabricate plausible-looking geometry.
        let mut b = Vec::with_capacity(bytes.len() + 1);
        b.extend_from_slice(b"solid ");
        b.extend_from_slice(&bytes[5..]);
        normalised = b;
        &normalised
    } else {
        bytes
    };

    let mut cursor = Cursor::new(bytes);
    let reader = stl_io::create_stl_reader(&mut cursor).map_err(ParseError::malformed)?;

    // Deliberately not `with_capacity(size_hint())`: the triangle count is
    // untrusted input, and pre-allocating from it is what made a malformed
    // file abort the process trying to allocate ~103 GB.
    let mut triangles = Vec::new();
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

    /// Regression: poking a float must not itself break the fixture, so the
    /// same helper writing a *finite* value still parses.
    #[test]
    fn poking_a_finite_value_still_parses() {
        let mesh = parse_stl(&poke_float(FIRST_VERTEX_X, 0.5)).unwrap();
        assert_eq!(mesh.triangles.len(), 12);
    }
}
