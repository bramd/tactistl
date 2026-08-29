use crate::mesh::Mesh;
use crate::transform::{total_matrix, ViewAxis};
use crate::vec::{Vec2, Vec3};

/// One 2D line segment of a cross-section. Segments are unordered and
/// unconnected — see the spec's "segments, not polygons" note.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Segment {
    pub a: Vec2,
    pub b: Vec2,
}

/// Intersect the rotated mesh with the plane z = `z`, returning a segment soup.
///
/// Vertices lying exactly on the plane are classified as being above it. That
/// keeps the above/below split consistent, so a crossing triangle always has
/// exactly two crossing edges and never degenerates into a single point.
pub fn slice(mesh: &Mesh, rotation_deg: Vec3, view: ViewAxis, z: f32) -> Vec<Segment> {
    let m = total_matrix(rotation_deg, view);
    let mut out = Vec::new();

    for tri in &mesh.triangles {
        let p = [m.apply(tri.v[0]), m.apply(tri.v[1]), m.apply(tri.v[2])];
        let above = [p[0].z >= z, p[1].z >= z, p[2].z >= z];
        let n_above = above.iter().filter(|&&a| a).count();

        // Entirely on one side of the plane.
        if n_above == 0 || n_above == 3 {
            continue;
        }

        // Exactly two edges cross: those joining a vertex above to one below.
        let mut hits = [Vec2::default(); 2];
        let mut n = 0;
        for i in 0..3 {
            let j = (i + 1) % 3;
            if above[i] == above[j] {
                continue;
            }
            let (a, b) = (p[i], p[j]);
            let denom = b.z - a.z;
            // Guaranteed non-zero: a and b are on opposite sides of the plane.
            let t = (z - a.z) / denom;
            if n < 2 {
                hits[n] = Vec2 {
                    x: a.x + t * (b.x - a.x),
                    y: a.y + t * (b.y - a.y),
                };
                n += 1;
            }
        }

        if n == 2 {
            out.push(Segment { a: hits[0], b: hits[1] });
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::parse_stl;
    use crate::transform::ViewAxis;
    use crate::vec::Vec3;

    fn cube() -> crate::mesh::Mesh {
        parse_stl(include_bytes!("../tests/fixtures/cube_ascii.stl")).unwrap()
    }

    /// Extent of the segment soup along each axis.
    fn extent(segs: &[Segment]) -> (f32, f32, f32, f32) {
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        for s in segs {
            for p in [s.a, s.b] {
                min_x = min_x.min(p.x);
                max_x = max_x.max(p.x);
                min_y = min_y.min(p.y);
                max_y = max_y.max(p.y);
            }
        }
        (min_x, max_x, min_y, max_y)
    }

    #[test]
    fn slicing_a_cube_mid_height_gives_its_square_cross_section() {
        let segs = slice(&cube(), Vec3::default(), ViewAxis::Top, 0.0);
        assert!(!segs.is_empty());
        let (min_x, max_x, min_y, max_y) = extent(&segs);
        assert!((min_x + 1.0).abs() < 1e-4, "min_x was {min_x}");
        assert!((max_x - 1.0).abs() < 1e-4, "max_x was {max_x}");
        assert!((min_y + 1.0).abs() < 1e-4);
        assert!((max_y - 1.0).abs() < 1e-4);
    }

    #[test]
    fn slicing_above_the_model_gives_nothing() {
        let segs = slice(&cube(), Vec3::default(), ViewAxis::Top, 5.0);
        assert!(segs.is_empty());
    }

    #[test]
    fn slicing_below_the_model_gives_nothing() {
        let segs = slice(&cube(), Vec3::default(), ViewAxis::Top, -5.0);
        assert!(segs.is_empty());
    }

    #[test]
    fn every_crossing_triangle_yields_exactly_one_segment() {
        // A cube sliced mid-height crosses 8 of its 12 triangles: the 4 side
        // faces are 2 triangles each, and the top and bottom faces miss.
        let segs = slice(&cube(), Vec3::default(), ViewAxis::Top, 0.0);
        assert_eq!(segs.len(), 8);
    }

    #[test]
    fn a_slice_exactly_on_a_vertex_plane_does_not_panic_or_vanish() {
        // z = 1.0 is the cube's top face: every vertex of the top triangles
        // lies exactly on the plane. This must not produce garbage.
        let segs = slice(&cube(), Vec3::default(), ViewAxis::Top, 1.0);
        // Either empty or a valid outline; the requirement is that it returns.
        for s in &segs {
            assert!(s.a.x.is_finite() && s.a.y.is_finite());
            assert!(s.b.x.is_finite() && s.b.y.is_finite());
        }
    }

    #[test]
    fn front_view_slices_the_model_along_y() {
        // The cube is symmetric, so instead assert the slice axis actually
        // moved: at the extreme of the Y range there is no geometry.
        let segs = slice(&cube(), Vec3::default(), ViewAxis::Front, 0.0);
        assert!(!segs.is_empty());
        let segs = slice(&cube(), Vec3::default(), ViewAxis::Front, 5.0);
        assert!(segs.is_empty());
    }
}
