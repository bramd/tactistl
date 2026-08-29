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
/// Vertices lying exactly on the plane are classified as being *above* it,
/// which keeps the above/below split consistent. The invariant that makes the
/// rest of the function correct is less obvious, so spelling it out:
///
/// Past the all-above/all-below early return, the number of crossing edges is
/// **always exactly two**. `above` is three booleans read around a cycle, and
/// the number of transitions around any cycle is necessarily even — so the
/// count can be 0 or 2 but never 1. It is 0 only when all three agree, which
/// the early return has already skipped. This holds for *any* coordinates,
/// NaN included, since `NaN >= z` is simply false and still a boolean.
///
/// Two consequences worth knowing:
///
/// - A triangle with one vertex exactly on the plane and the other two below
///   produces a **zero-length** segment, not a dropped one: both crossing
///   edges meet at that on-plane vertex, so both hits are the same point.
///   Harmless — outline mode draws it as a single dot, and a scanline fill
///   sees a zero-height span and contributes nothing.
/// - A triangle lying fully in the plane classifies as all-above and is
///   skipped entirely. So slicing exactly at a model's maximum Z still yields
///   an outline (supplied by the neighbouring triangles below it), whereas
///   slicing exactly at its minimum Z yields nothing at all. Callers choosing
///   a slice height are expected to stay inside the open range.
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
        // The `n` bounds checks below are defensive only — by the parity
        // argument in the doc comment `n` provably ends at 2 — but they are
        // kept so a future change to the classification cannot turn an
        // overrun into a panic or a silent out-of-range write.
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

    /// The cube fixture stretched to distinct extents on every axis, so a
    /// cross-section identifies which view produced it. The symmetric cube
    /// cannot: every view of it looks the same.
    fn brick() -> crate::mesh::Mesh {
        let mut m = cube();
        for t in &mut m.triangles {
            for v in &mut t.v {
                v.x *= 1.0; // half-extent 1
                v.y *= 2.0; // half-extent 2
                v.z *= 3.0; // half-extent 3
            }
        }
        m
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

    /// Only sound as a pair with
    /// `every_crossing_triangle_yields_exactly_one_segment`: this test pins the
    /// outline's coordinates but not how many segments trace it, so an
    /// implementation emitting duplicates over the same outline still passes.
    /// Do not delete either.
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

    /// Only sound as a pair with
    /// `slicing_a_cube_mid_height_gives_its_square_cross_section`: a count
    /// alone would still pass for an implementation emitting 8 segments with
    /// entirely wrong coordinates. That test pins the coordinates.
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
        // Not merely "it returns": the outline must still be there. Each of the
        // 8 side-face triangles has vertices at z = 1 (classified above) and at
        // z = -1 (below), so all 8 cross. The top face's own triangles are all
        // on the plane, hence all-above, and are skipped.
        assert_eq!(segs.len(), 8);
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

    /// The `view` argument must actually reach the transform. The symmetric
    /// cube cannot show that — every view of it yields the same square — so
    /// slice the asymmetric brick (half-extents X=1, Y=2, Z=3) and pin the
    /// cross-section's world-XY extents, which differ per view:
    ///
    /// - `Top` is the identity: world X <- model X (1), world Y <- model Y (2).
    /// - `Front` is Rx(-90): model +X -> +X, +Y -> -Z, +Z -> +Y. So world
    ///   X <- model X (1), world Y <- model Z (3); the slice axis is model Y.
    /// - `Side` is Rx(-90)*Rz(90): model +X -> -Z, +Y -> -X, +Z -> +Y. So
    ///   world X <- model -Y (2), world Y <- model Z (3); slice axis model X.
    #[test]
    fn each_view_gives_its_own_cross_section() {
        let expected = [
            (ViewAxis::Top, 1.0, 2.0),
            (ViewAxis::Front, 1.0, 3.0),
            (ViewAxis::Side, 2.0, 3.0),
        ];
        for (view, hx, hy) in expected {
            let segs = slice(&brick(), Vec3::default(), view, 0.0);
            assert!(!segs.is_empty(), "{view:?} sliced to nothing");
            let (min_x, max_x, min_y, max_y) = extent(&segs);
            let got = (min_x, max_x, min_y, max_y);
            let want = (-hx, hx, -hy, hy);
            assert!(
                (min_x + hx).abs() < 1e-4
                    && (max_x - hx).abs() < 1e-4
                    && (min_y + hy).abs() < 1e-4
                    && (max_y - hy).abs() < 1e-4,
                "{view:?}: expected {want:?}, got {got:?}"
            );
        }
    }
}
