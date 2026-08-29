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
    /// The bytes are not a readable ASCII or binary STL.
    Malformed(String),
    /// Parsed successfully but contains no triangles.
    NoGeometry,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::Malformed(m) => write!(f, "could not read STL: {m}"),
            ParseError::NoGeometry => write!(f, "the file contains no triangles"),
        }
    }
}

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

/// Parse an ASCII or binary STL. The format is auto-detected by `stl_io`.
pub fn parse_stl(bytes: &[u8]) -> Result<Mesh, ParseError> {
    let mut cursor = Cursor::new(bytes);
    let reader = stl_io::create_stl_reader(&mut cursor)
        .map_err(|e| ParseError::Malformed(e.to_string()))?;

    let mut triangles = Vec::new();
    for tri in reader {
        let tri = tri.map_err(|e| ParseError::Malformed(e.to_string()))?;
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
}
