use crate::vec::Vec2;

/// The physical width of a pin divided by its height. The Dot Pad's graphic
/// area is assumed to have square pin pitch; verify against hardware by
/// slicing a sphere at mid-height and checking the circle does not feel
/// elliptical, then adjust here if needed.
pub const PIN_ASPECT: f32 = 1.0;

/// Maps model XY into grid coordinates: aspect-preserving, centred, with the
/// model's +Y pointing at the top of the grid (row 0).
#[derive(Debug, Clone, Copy)]
pub struct Fit {
    scale: f32,
    min_x: f32,
    min_y: f32,
    off_x: f32,
    off_y: f32,
    span_y: f32,
}

impl Fit {
    pub fn new(min_x: f32, min_y: f32, max_x: f32, max_y: f32, width: usize, height: usize) -> Fit {
        // The usable span is one less than the dot count: a dot sits at each
        // end, so N dots span N-1 gaps.
        let span_x = (width.max(1) - 1) as f32;
        let span_y = (height.max(1) - 1) as f32;

        let model_w = (max_x - min_x).max(0.0);
        // A pin wider than it is tall needs proportionally fewer columns to
        // cover the same physical distance.
        let model_h = (max_y - min_y).max(0.0) / PIN_ASPECT;

        // Take the tighter of the two scales, guarding against a zero-size
        // model on either axis (a flat slice range, or a single point).
        let sx = if model_w > 0.0 {
            span_x / model_w
        } else {
            f32::INFINITY
        };
        let sy = if model_h > 0.0 {
            span_y / model_h
        } else {
            f32::INFINITY
        };
        let tightest = sx.min(sy);
        // Both axes zero-size: scale is meaningless, everything lands centred.
        let scale = if tightest.is_finite() { tightest } else { 0.0 };

        Fit {
            scale,
            min_x,
            min_y,
            off_x: (span_x - model_w * scale) / 2.0,
            off_y: (span_y - model_h * scale) / 2.0,
            span_y,
        }
    }

    /// Floating-point grid coordinates: x to the right, y downward.
    pub fn to_grid(&self, p: Vec2) -> (f32, f32) {
        let x = (p.x - self.min_x) * self.scale + self.off_x;
        let y = ((p.y - self.min_y) / PIN_ASPECT) * self.scale + self.off_y;
        // Grid row 0 is the top of the display; model +Y is up.
        (x, self.span_y - y)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_square_model_in_a_square_grid_fills_it_corner_to_corner() {
        let f = Fit::new(0.0, 0.0, 10.0, 10.0, 11, 11);
        let bl = f.to_grid(Vec2 { x: 0.0, y: 0.0 });
        let tr = f.to_grid(Vec2 { x: 10.0, y: 10.0 });
        // Model +Y is up, grid row 0 is the top, so the model's bottom-left
        // lands at the grid's bottom-left.
        assert!((bl.0 - 0.0).abs() < 1e-4, "x was {}", bl.0);
        assert!((bl.1 - 10.0).abs() < 1e-4, "y was {}", bl.1);
        assert!((tr.0 - 10.0).abs() < 1e-4);
        assert!((tr.1 - 0.0).abs() < 1e-4);
    }

    #[test]
    fn a_wide_model_is_centred_vertically_with_padding() {
        // 20 wide, 10 tall model into a 21x21 grid: width is the limit, so the
        // model occupies the middle 11 rows.
        let f = Fit::new(0.0, 0.0, 20.0, 10.0, 21, 21);
        let bottom = f.to_grid(Vec2 { x: 0.0, y: 0.0 });
        let top = f.to_grid(Vec2 { x: 0.0, y: 10.0 });
        assert!((bottom.0 - 0.0).abs() < 1e-4);
        assert!((top.1 - 5.0).abs() < 1e-4, "top row was {}", top.1);
        assert!((bottom.1 - 15.0).abs() < 1e-4, "bottom row was {}", bottom.1);
    }

    #[test]
    fn aspect_ratio_is_preserved() {
        // A circle must stay a circle: the same model distance maps to the
        // same grid distance on both axes.
        let f = Fit::new(0.0, 0.0, 20.0, 10.0, 60, 40);
        let dx = f.to_grid(Vec2 { x: 1.0, y: 0.0 }).0 - f.to_grid(Vec2 { x: 0.0, y: 0.0 }).0;
        let dy = f.to_grid(Vec2 { x: 0.0, y: 0.0 }).1 - f.to_grid(Vec2 { x: 0.0, y: 1.0 }).1;
        assert!((dx - dy).abs() < 1e-4, "dx {dx} != dy {dy}");
    }

    #[test]
    fn a_degenerate_flat_model_does_not_produce_nan() {
        // A perfectly flat slice range: zero height.
        let f = Fit::new(0.0, 5.0, 10.0, 5.0, 60, 40);
        let p = f.to_grid(Vec2 { x: 5.0, y: 5.0 });
        assert!(p.0.is_finite() && p.1.is_finite(), "got {p:?}");
    }

    #[test]
    fn a_zero_size_model_centres_in_the_grid() {
        let f = Fit::new(3.0, 3.0, 3.0, 3.0, 61, 41);
        let p = f.to_grid(Vec2 { x: 3.0, y: 3.0 });
        assert!((p.0 - 30.0).abs() < 1e-4, "x was {}", p.0);
        assert!((p.1 - 20.0).abs() < 1e-4, "y was {}", p.1);
    }
}
