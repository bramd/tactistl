pub mod mesh;
pub mod raster;
pub mod slice;
pub mod transform;
pub mod vec;

use mesh::Mesh;
use raster::{fill::fill_scanlines, fit::Fit, outline::draw_line, Bitmap};
use slice::Segment;
use transform::ViewAxis;
use vec::{Vec2, Vec3};

/// Everything the geometry pipeline needs for one frame.
#[derive(Debug, Clone, Copy)]
pub struct RenderParams {
    pub rotation_deg: Vec3,
    pub view: ViewAxis,
    /// Position along the slice axis, in the rotated frame.
    pub z: f32,
    pub width: usize,
    pub height: usize,
    pub filled: bool,
    pub mirror: bool,
}

/// The rotated axis-aligned bounds. The Z range is the scrubber's range; the
/// XY range is the framing box for every slice at this rotation.
pub fn bounds(mesh: &Mesh, rotation_deg: Vec3, view: ViewAxis) -> vec::Bbox3 {
    transform::rotated_bounds(mesh, rotation_deg, view)
}

/// Slice the rotated mesh and rasterize the cross-section to a dot grid.
pub fn render(mesh: &Mesh, p: &RenderParams) -> Bitmap {
    let b = bounds(mesh, p.rotation_deg, p.view);
    let mut bmp = Bitmap::new(p.width, p.height);
    if b.is_empty() {
        return bmp;
    }

    // `z` is treated two different ways depending on how far out of range it
    // is, because the two cases mean different things.
    //
    // *At* an endpoint is a legitimate request: the scrubber's range is exactly
    // `[min_z, max_z]`, taken from `bounds`, so the UI can and will ask for
    // both ends. But slicing exactly on a face plane yields nothing, because
    // on-plane vertices classify as above — so the ends would go blank. Nudging
    // `z` a hair inside the model keeps them rendering. `eps` is 1e-4 of the
    // depth, four orders of magnitude below one dot on a 40-row grid, so the
    // geometry it skips is far too small to feel.
    //
    // *Far* outside the range is a caller bug — the UI cannot produce it. There
    // is no sensible cross-section to show, and clamping such a `z` all the way
    // back to a face would answer a nonsense question with a plausible-looking
    // picture. A blank grid is the honest answer.
    //
    // `eps` is a fraction of the depth, so `min + eps <= max - eps` holds for
    // every `depth >= 0` (it reduces to `2e-4 * depth <= depth`). The clamp
    // range can therefore never invert, and a flat model just collapses to
    // `eps == 0` and a single degenerate plane. `contains` is false for a NaN
    // `z`, which also lands on blank.
    let depth = b.max.z - b.min.z;
    let eps = depth * 1e-4;
    if !(b.min.z - eps..=b.max.z + eps).contains(&p.z) {
        return bmp;
    }
    let z = p.z.clamp(b.min.z + eps, b.max.z - eps);

    let segments = slice::slice(mesh, p.rotation_deg, p.view, z);
    if segments.is_empty() {
        return bmp;
    }

    let fit = Fit::new(b.min.x, b.min.y, b.max.x, b.max.y, p.width, p.height);
    let grid: Vec<Segment> = segments
        .iter()
        .map(|s| {
            let (ax, ay) = fit.to_grid(s.a);
            let (bx, by) = fit.to_grid(s.b);
            Segment { a: Vec2 { x: ax, y: ay }, b: Vec2 { x: bx, y: by } }
        })
        .collect();

    if p.filled {
        // Fill first, then union the outline so thin features and open edges
        // of a non-watertight mesh still show.
        fill_scanlines(&mut bmp, &grid);
    }
    for s in &grid {
        draw_line(&mut bmp, s.a.x, s.a.y, s.b.x, s.b.y);
    }

    // Mirroring is a reflection of the finished raster, not of the coordinate
    // mapping, so it is exact — see Bitmap::mirror_horizontal.
    if p.mirror {
        bmp.mirror_horizontal();
    }

    bmp
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cube() -> Mesh {
        mesh::parse_stl(include_bytes!("../tests/fixtures/cube_ascii.stl")).unwrap()
    }

    fn params() -> RenderParams {
        RenderParams {
            rotation_deg: Vec3::default(),
            view: ViewAxis::Top,
            z: 0.0,
            width: 60,
            height: 40,
            filled: false,
            mirror: false,
        }
    }

    /// The inclusive range of rows containing at least one dot.
    fn row_extent(b: &Bitmap) -> (usize, usize) {
        let mut lo = usize::MAX;
        let mut hi = 0usize;
        for y in 0..b.height {
            if (0..b.width).any(|x| b.get(x, y) == 1) {
                lo = lo.min(y);
                hi = hi.max(y);
            }
        }
        (lo, hi)
    }

    #[test]
    fn renders_a_cube_cross_section_as_an_outline() {
        let bmp = render(&cube(), &params());
        assert_eq!(bmp.width, 60);
        assert_eq!(bmp.height, 40);
        assert!(bmp.count_set() > 0, "the outline must set some dots");
        // Outline, not filled: the centre stays empty.
        assert_eq!(bmp.get(30, 20), 0);
    }

    #[test]
    fn filled_mode_fills_the_centre() {
        let mut p = params();
        p.filled = true;
        let bmp = render(&cube(), &p);
        assert_eq!(bmp.get(30, 20), 1);
    }

    #[test]
    fn filled_mode_still_draws_the_outline() {
        // The outline is unioned in so thin features never vanish.
        let mut p = params();
        p.filled = true;
        let filled = render(&cube(), &p);
        p.filled = false;
        let outline = render(&cube(), &p);

        // Without these two guards the loop below asserts nothing when the
        // outline renders empty, and a size mismatch would panic on an index
        // or silently leave a tail unchecked rather than failing as itself.
        assert_eq!(
            (outline.width, outline.height),
            (filled.width, filled.height),
            "the two renders must be the same size to compare dot for dot"
        );
        assert!(
            outline.count_set() > 0,
            "the outline render was empty, so the superset check below would \
             pass without comparing anything"
        );

        for i in 0..filled.data.len() {
            if outline.data[i] == 1 {
                assert_eq!(filled.data[i], 1, "outline dot {i} missing from the fill");
            }
        }
    }

    #[test]
    fn a_slice_that_misses_the_model_is_blank_not_an_error() {
        let mut p = params();
        p.z = 100.0;
        let bmp = render(&cube(), &p);
        assert_eq!(bmp.count_set(), 0);
    }

    #[test]
    fn mirroring_reflects_the_raster_horizontally() {
        // Rotate so the cross-section is not left/right symmetric.
        let mut p = params();
        p.rotation_deg = Vec3::new(0.0, 0.0, 20.0);
        let plain = render(&cube(), &p);
        p.mirror = true;
        let mirrored = render(&cube(), &p);
        assert_eq!(plain.count_set(), mirrored.count_set());
        for y in 0..plain.height {
            for x in 0..plain.width {
                assert_eq!(
                    plain.get(x, y),
                    mirrored.get(plain.width - 1 - x, y),
                    "mismatch at {x},{y}"
                );
            }
        }
    }

    #[test]
    fn the_framing_box_is_the_whole_model_not_the_slice() {
        // Tilt the cube about X so its cross-sections vary in height as the
        // slice moves. Framed by the whole model, a short cross-section must
        // occupy only part of the grid. Framed per slice, EVERY cross-section
        // would be stretched to fill the grid, and this would fail.
        let mut p = params();
        p.rotation_deg = Vec3::new(30.0, 0.0, 0.0);
        let b = transform::rotated_bounds(&cube(), p.rotation_deg, p.view);
        let depth = b.max.z - b.min.z;

        p.z = b.min.z + depth * 0.5;
        let middle = render(&cube(), &p);
        p.z = b.min.z + depth * 0.03;
        let near_end = render(&cube(), &p);

        assert!(middle.count_set() > 0 && near_end.count_set() > 0);

        let (mid_lo, mid_hi) = row_extent(&middle);
        let (end_lo, end_hi) = row_extent(&near_end);
        assert!(
            end_hi - end_lo < mid_hi - mid_lo,
            "the end slice ({end_lo}..{end_hi}) should be shorter than the \
             middle slice ({mid_lo}..{mid_hi}); a per-slice fit would make \
             them the same height"
        );
    }

    #[test]
    fn bounds_reports_the_rotated_extent() {
        let b = bounds(&cube(), Vec3::default(), ViewAxis::Top);
        assert!((b.min.z + 1.0).abs() < 1e-5);
        assert!((b.max.z - 1.0).abs() < 1e-5);
    }

    #[test]
    fn both_ends_of_the_scrub_range_render_geometry() {
        // Slicing exactly at min_z classifies every vertex as above the plane
        // and yields nothing; exactly at max_z yields nothing either. The
        // scrubber must not go blank at its extremes, so render clamps the
        // slice position inside the model.
        let p_min = RenderParams { z: -1.0, ..params() };
        let p_max = RenderParams { z: 1.0, ..params() };
        assert!(render(&cube(), &p_min).count_set() > 0, "bottom of the range was blank");
        assert!(render(&cube(), &p_max).count_set() > 0, "top of the range was blank");
    }
}
