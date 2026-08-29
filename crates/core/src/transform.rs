use crate::mesh::Mesh;
use crate::vec::{Bbox3, Mat3, Vec3};

/// Which direction the model is viewed from. Each preset is a rotation applied
/// *outside* the user's own rotation; slicing then always happens along Z.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewAxis {
    /// Horizontal slices. Scrubs the model's Z.
    Top,
    /// Scrubs the model's Y.
    Front,
    /// Scrubs the model's X.
    Side,
}

impl ViewAxis {
    pub fn from_u8(v: u8) -> ViewAxis {
        match v {
            1 => ViewAxis::Front,
            2 => ViewAxis::Side,
            _ => ViewAxis::Top,
        }
    }
}

fn rot_x(rad: f32) -> Mat3 {
    let (s, c) = rad.sin_cos();
    Mat3([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])
}

fn rot_y(rad: f32) -> Mat3 {
    let (s, c) = rad.sin_cos();
    Mat3([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])
}

fn rot_z(rad: f32) -> Mat3 {
    let (s, c) = rad.sin_cos();
    Mat3([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
}

/// Euler angles in degrees about the *world* axes, applied X first, then Y,
/// then Z. As a matrix product that is Rz * Ry * Rx.
pub fn euler_deg(x: f32, y: f32, z: f32) -> Mat3 {
    let r = std::f32::consts::PI / 180.0;
    rot_z(z * r).mul(&rot_y(y * r).mul(&rot_x(x * r)))
}

/// The preset rotation for a view direction.
pub fn view_matrix(view: ViewAxis) -> Mat3 {
    match view {
        ViewAxis::Top => Mat3::identity(),
        // -90 about X sends model +Y to world -Z, so scrubbing world Z walks
        // the model's Y from its maximum toward its minimum. Model +Z comes up.
        ViewAxis::Front => euler_deg(-90.0, 0.0, 0.0),
        // A right-side view is the Front preset applied after spinning the
        // model 90 degrees about Z. Doing it as rot_y(90) instead would put
        // the model's Z on screen-right and its Y up — i.e. the model would
        // render rotated 90 degrees, which defeats an orientation checker.
        // Scrubbing world Z walks the model's X from its maximum toward its
        // minimum, with model +Z up.
        ViewAxis::Side => euler_deg(-90.0, 0.0, 0.0).mul(&euler_deg(0.0, 0.0, 90.0)),
    }
}

/// R_view * R_user. The user's orientation is applied first.
pub fn total_matrix(rotation_deg: Vec3, view: ViewAxis) -> Mat3 {
    view_matrix(view).mul(&euler_deg(rotation_deg.x, rotation_deg.y, rotation_deg.z))
}

/// The axis-aligned bounds of the mesh *after* the full rotation. This is the
/// framing box for every slice at this rotation — see the spec's "stable raster
/// framing" note.
pub fn rotated_bounds(mesh: &Mesh, rotation_deg: Vec3, view: ViewAxis) -> Bbox3 {
    let m = total_matrix(rotation_deg, view);
    let mut b = Bbox3::empty();
    for t in &mesh.triangles {
        for v in t.v {
            b.include(m.apply(v));
        }
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: Vec3, b: Vec3) {
        let d = 1e-5;
        assert!(
            (a.x - b.x).abs() < d && (a.y - b.y).abs() < d && (a.z - b.z).abs() < d,
            "expected {b:?}, got {a:?}"
        );
    }

    #[test]
    fn zero_rotation_is_identity() {
        let m = euler_deg(0.0, 0.0, 0.0);
        approx(m.apply(Vec3::new(1.0, 2.0, 3.0)), Vec3::new(1.0, 2.0, 3.0));
    }

    #[test]
    fn rotates_90_about_x() {
        // +Y goes to +Z.
        let m = euler_deg(90.0, 0.0, 0.0);
        approx(m.apply(Vec3::new(0.0, 1.0, 0.0)), Vec3::new(0.0, 0.0, 1.0));
    }

    #[test]
    fn rotates_90_about_z() {
        // +X goes to +Y.
        let m = euler_deg(0.0, 0.0, 90.0);
        approx(m.apply(Vec3::new(1.0, 0.0, 0.0)), Vec3::new(0.0, 1.0, 0.0));
    }

    #[test]
    fn euler_order_is_x_then_y_then_z() {
        // Applying X then Z to +Y: X(90) sends +Y to +Z; Z(90) leaves +Z alone.
        let m = euler_deg(90.0, 0.0, 90.0);
        approx(m.apply(Vec3::new(0.0, 1.0, 0.0)), Vec3::new(0.0, 0.0, 1.0));
        // Applying X then Z to +X: X(90) leaves +X; Z(90) sends +X to +Y.
        approx(m.apply(Vec3::new(1.0, 0.0, 0.0)), Vec3::new(0.0, 1.0, 0.0));
    }

    #[test]
    fn front_view_slices_along_model_y() {
        // Front view must map the model's Y axis onto the slice (world Z) axis.
        let m = view_matrix(ViewAxis::Front);
        let out = m.apply(Vec3::new(0.0, 1.0, 0.0));
        assert!(out.z.abs() > 0.99, "model +Y should land on the Z axis, got {out:?}");
    }

    #[test]
    fn side_view_slices_along_model_x() {
        let m = view_matrix(ViewAxis::Side);
        let out = m.apply(Vec3::new(1.0, 0.0, 0.0));
        assert!(out.z.abs() > 0.99, "model +X should land on the Z axis, got {out:?}");
    }

    #[test]
    fn top_view_slices_along_model_z() {
        let m = view_matrix(ViewAxis::Top);
        approx(m.apply(Vec3::new(0.0, 0.0, 1.0)), Vec3::new(0.0, 0.0, 1.0));
    }

    #[test]
    fn top_view_basis_is_identity() {
        let m = view_matrix(ViewAxis::Top);
        approx(m.apply(Vec3::new(1.0, 0.0, 0.0)), Vec3::new(1.0, 0.0, 0.0));
        approx(m.apply(Vec3::new(0.0, 1.0, 0.0)), Vec3::new(0.0, 1.0, 0.0));
        approx(m.apply(Vec3::new(0.0, 0.0, 1.0)), Vec3::new(0.0, 0.0, 1.0));
    }

    /// Pins the whole basis, not just the slice axis: model X stays on screen
    /// right and model Z comes up, so the view cannot silently roll the model.
    #[test]
    fn front_view_puts_model_z_up() {
        let m = view_matrix(ViewAxis::Front);
        approx(m.apply(Vec3::new(1.0, 0.0, 0.0)), Vec3::new(1.0, 0.0, 0.0));
        approx(m.apply(Vec3::new(0.0, 1.0, 0.0)), Vec3::new(0.0, 0.0, -1.0));
        approx(m.apply(Vec3::new(0.0, 0.0, 1.0)), Vec3::new(0.0, 1.0, 0.0));
    }

    /// As above for the side view. A bare `rot_y(90)` also lands model X on the
    /// slice axis but leaves model Y up and model Z on screen right, i.e. the
    /// model rendered on its side; this pins the up axis so that cannot recur.
    #[test]
    fn side_view_puts_model_z_up() {
        let m = view_matrix(ViewAxis::Side);
        approx(m.apply(Vec3::new(1.0, 0.0, 0.0)), Vec3::new(0.0, 0.0, -1.0));
        approx(m.apply(Vec3::new(0.0, 1.0, 0.0)), Vec3::new(-1.0, 0.0, 0.0));
        approx(m.apply(Vec3::new(0.0, 0.0, 1.0)), Vec3::new(0.0, 1.0, 0.0));
    }

    #[test]
    fn every_view_preset_is_a_proper_rotation() {
        // A determinant of -1 would mean the preset mirrors the model, which
        // would show a mirror image rather than a rotated one.
        for view in [ViewAxis::Top, ViewAxis::Front, ViewAxis::Side] {
            let m = view_matrix(view).0;
            let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
            assert!((det - 1.0).abs() < 1e-5, "{view:?} has determinant {det}");
        }
    }

    #[test]
    fn total_matrix_applies_user_rotation_before_view() {
        // R_total = R_view * R_user. With a Front view and a user rotation that
        // sends +Z to +Y, the composite must send +Z back onto the Z axis.
        let total = total_matrix(Vec3::new(-90.0, 0.0, 0.0), ViewAxis::Front);
        let out = total.apply(Vec3::new(0.0, 0.0, 1.0));
        assert!(out.z.abs() > 0.99, "expected +Z on the slice axis, got {out:?}");
    }

    #[test]
    fn rotated_bounds_of_unit_cube_grow_under_45_degrees() {
        let mesh = crate::mesh::parse_stl(include_bytes!("../tests/fixtures/cube_ascii.stl")).unwrap();
        let b = rotated_bounds(&mesh, Vec3::new(0.0, 0.0, 45.0), ViewAxis::Top);
        // A 2x2 square rotated 45 degrees spans 2*sqrt(2) across.
        assert!((b.max.x - b.min.x - 2.0 * std::f32::consts::SQRT_2).abs() < 1e-4);
        // Z is untouched by a Z rotation.
        assert!((b.max.z - b.min.z - 2.0).abs() < 1e-5);
    }
}
