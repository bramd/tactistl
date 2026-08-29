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
    } else if bytes.starts_with(b"solid") && bytes.get(5).is_none_or(|c| *c != b' ') {
        // Workaround: an empty solid name (`solid\n`) is legal but fails the
        // upstream probe, so insert the space it insists on.
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

    let mut triangles = Vec::new();
    for tri in reader {
        let tri = tri.map_err(ParseError::malformed)?;
        let v = |i: usize| {
            let p = tri.vertices[i];
            Vec3::new(p[0], p[1], p[2])
        };
        triangles.push(Triangle { v: [v(0), v(1), v(2)] });
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
}
