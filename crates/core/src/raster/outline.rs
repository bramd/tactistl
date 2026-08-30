use crate::raster::Bitmap;

/// Draws a line with Bresenham's algorithm, rounding the endpoints to dots.
///
/// Rounding, not truncation: `Fit::to_grid` can return a tiny negative value on
/// the top edge, which must land on row 0 rather than off the grid.
///
/// Termination does not rest on the step bound below. After rounding, both
/// endpoints are exact integers and each iteration advances at least one axis
/// one step towards its target, so `x == x1 && y == y1` is always reached.
///
/// # Clipping
///
/// A segment can start far outside the grid, so the traversal is clipped. The
/// clipping is *parametric*: the step index is restricted to the window in
/// which the major axis is on the grid, and the loop's exact state on entering
/// that window is restored in closed form. The endpoints themselves are never
/// moved, so `dx`, `dy` and the error sequence are those of the full line.
///
/// That distinction is the whole point. Pulling each endpoint onto the grid
/// independently — or clipping the segment geometrically and re-rounding where
/// it crosses the edge — displaces it by up to half a dot, which changes the
/// line's slope and phase and so sets *different dots inside the grid*. Both
/// were measured against an unclipped traversal over segments crossing a 60x40
/// grid: an independent clamp put one test line's entry dot nine rows out, and
/// clip-and-re-round disagreed on 87% of segments. Restoring the loop state
/// instead is exact, and `matches_an_unclipped_bresenham_dot_for_dot` pins it.
///
/// Cost is one traversal of the grid's larger dimension, however distant the
/// endpoints.
pub fn draw_line(bmp: &mut Bitmap, x0: f32, y0: f32, x1: f32, y1: f32) {
    if !(x0.is_finite() && y0.is_finite() && x1.is_finite() && y1.is_finite()) {
        return;
    }

    // `as i32` saturates rather than wrapping, so an absurd coordinate stays
    // absurd instead of folding back onto the grid. i64 then holds any
    // difference of two i32s.
    let (x0, y0) = (x0.round() as i32 as i64, y0.round() as i32 as i64);
    let (x1, y1) = (x1.round() as i32 as i64, y1.round() as i32 as i64);

    let dx = (x1 - x0).abs();
    let dy = -(y1 - y0).abs();
    let sx: i64 = if x0 < x1 { 1 } else { -1 };
    let sy: i64 = if y0 < y1 { 1 } else { -1 };

    // The major axis steps on every iteration, so the step index is its
    // distance travelled; the minor axis steps on some of them.
    let x_major = dx >= -dy;
    let (major, minor) = if x_major { (dx, -dy) } else { (-dy, dx) };
    let (start, step, extent) = if x_major {
        (x0, sx, bmp.width as i64)
    } else {
        (y0, sy, bmp.height as i64)
    };

    // Step indices whose major coordinate is on the grid, and which are on the
    // segment at all.
    let (first, last) = if step == 1 {
        (-start, extent - 1 - start)
    } else {
        (start - extent + 1, start)
    };
    let (first, last) = (first.max(0), last.min(major));
    if first > last {
        return;
    }

    // How far the minor axis has travelled after `first` steps. The product
    // overflows 64 bits for a distant endpoint, but the quotient is at most
    // `minor`, so only the intermediate needs the wider type — and this runs
    // once per segment, not once per dot.
    let minor_travelled = if major == 0 {
        0
    } else {
        ((2 * minor as i128 * first as i128 + major as i128) / (2 * major as i128)) as i64
    };
    let (steps_x, steps_y) = if x_major {
        (first, minor_travelled)
    } else {
        (minor_travelled, first)
    };
    // Both coordinates stay between their endpoints, so both still fit an i32.
    let (mut x, mut y) = (x0 + sx * steps_x, y0 + sy * steps_y);
    // The error term is `dx + dy` at the start, and each x or y step adds `dy`
    // or `dx`. Its running value is bounded by `dx - dy`; only this once-off
    // reconstruction needs the wider type.
    let mut err = ((dx + dy) as i128 + steps_x as i128 * dy as i128 + steps_y as i128 * dx as i128)
        as i64;

    for _ in first..=last {
        bmp.set(x as i32, y as i32);
        if x == x1 && y == y1 {
            break;
        }
        let e2 = 2 * err;
        if e2 >= dy {
            err += dy;
            x += sx;
        }
        if e2 <= dx {
            err += dx;
            y += sy;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The definition of correct: round the endpoints, walk the whole line with
    /// plain Bresenham, and drop the writes that land outside the grid.
    ///
    /// `draw_line` may not walk the whole line — for a distant endpoint that
    /// would cost thousands of iterations to draw a handful of dots — but the
    /// dots it does draw must be exactly these.
    fn reference(width: usize, height: usize, x0: f32, y0: f32, x1: f32, y1: f32) -> Bitmap {
        let mut bmp = Bitmap::new(width, height);
        let (mut x, mut y) = (x0.round() as i32, y0.round() as i32);
        let (x1, y1) = (x1.round() as i32, y1.round() as i32);
        let dx = (x1 - x).abs();
        let dy = -(y1 - y).abs();
        let sx = if x < x1 { 1 } else { -1 };
        let sy = if y < y1 { 1 } else { -1 };
        let mut err = dx + dy;
        loop {
            bmp.set(x, y);
            if x == x1 && y == y1 {
                break;
            }
            let e2 = 2 * err;
            if e2 >= dy {
                err += dy;
                x += sx;
            }
            if e2 <= dx {
                err += dx;
                y += sy;
            }
        }
        bmp
    }

    /// Both major axes, all four directions on each, endpoints far outside the
    /// grid, wholly inside, wholly outside, a single corner dot, and zero
    /// length. Fixed rather than random so a failure is reproducible.
    const CASES: &[(&str, f32, f32, f32, f32)] = &[
        ("shallow, from far left", -10000.0, 200.0, 20.0, 20.0),
        ("shallow, reversed", 20.0, 20.0, -10000.0, 200.0),
        ("steep, from far above", -1000.0, 10000.0, 30.0, 20.0),
        ("horizontal, crossing", -50.0, 5.0, 50.0, 5.0),
        ("horizontal, right to left", 50.0, 5.0, -50.0, 5.0),
        ("vertical, crossing", 3.0, -100.0, 3.0, 100.0),
        ("vertical, bottom to top", 3.0, 100.0, 3.0, -100.0),
        ("x-major, down-right", -500.0, -300.0, 500.0, 300.0),
        ("x-major, up-right", -500.0, 300.0, 500.0, -300.0),
        ("x-major, down-left", 500.0, -300.0, -500.0, 300.0),
        ("x-major, up-left", 500.0, 300.0, -500.0, -300.0),
        ("y-major, down-right", -300.0, -500.0, 300.0, 500.0),
        ("y-major, up-right", -300.0, 500.0, 300.0, -500.0),
        ("y-major, down-left", 300.0, -500.0, -300.0, 500.0),
        ("y-major, up-left", 300.0, 500.0, -300.0, -500.0),
        ("awkward slope, far endpoints", -3000.0, 7000.0, 41.0, -13.0),
        ("wholly inside", 10.0, 10.0, 50.0, 30.0),
        ("misses the grid, but spans its columns", -100.0, 500.0, 100.0, 400.0),
        ("wholly outside", -100.0, -100.0, -50.0, -90.0),
        ("clips to the single corner dot at 0,0", -20.0, 20.0, 20.0, -20.0),
        ("clips to the single corner dot at 59,39", 39.0, 59.0, 79.0, 19.0),
        ("zero length, inside", 30.0, 20.0, 30.0, 20.0),
        ("zero length, outside", -5.0, -5.0, -5.0, -5.0),
        // Fit::to_grid can return a tiny negative value on the top edge.
        ("sub-dot negative on the top edge", -1.9e-6, -1.9e-6, 30.0, 20.0),
    ];

    /// Listed rather than compared as whole `Bitmap`s: a mismatch names the
    /// dots that differ instead of dumping 2400 bytes.
    fn dots(bmp: &Bitmap) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        for y in 0..bmp.height {
            for x in 0..bmp.width {
                if bmp.get(x, y) == 1 {
                    out.push((x, y));
                }
            }
        }
        out
    }

    /// The load-bearing test: clipping may not change which dots land on the
    /// grid, only how long it takes to get there.
    #[test]
    fn matches_an_unclipped_bresenham_dot_for_dot() {
        for &(name, x0, y0, x1, y1) in CASES {
            let mut got = Bitmap::new(60, 40);
            draw_line(&mut got, x0, y0, x1, y1);
            let want = reference(60, 40, x0, y0, x1, y1);
            assert_eq!(dots(&got), dots(&want), "{name}");
        }
    }

    /// Regression test for a clamp that pulled each endpoint into a box
    /// independently: that steepened this line's slope and put its entry dot
    /// nine rows low, at (0, 29).
    ///
    /// Sound only as a pair with `matches_an_unclipped_bresenham_dot_for_dot`.
    /// This case does NOT discriminate against clipping the segment and then
    /// re-rounding its endpoints, which also yields (0, 20) here while
    /// disagreeing with an unclipped traversal on most segments. The reference
    /// comparison is what pins the property; this pins the one known bug.
    #[test]
    fn clipping_does_not_distort_the_slope() {
        let mut bmp = Bitmap::new(60, 40);
        draw_line(&mut bmp, -10000.0, 200.0, 20.0, 20.0);
        assert_eq!(bmp.get(0, 20), 1, "the line enters the grid at row 20");
        assert_eq!(
            bmp.get(0, 29),
            0,
            "row 29 is where an independent endpoint clamp put it"
        );
    }

    #[test]
    fn draws_a_horizontal_line() {
        let mut bmp = Bitmap::new(10, 10);
        draw_line(&mut bmp, 2.0, 5.0, 7.0, 5.0);
        for x in 2..=7 {
            assert_eq!(bmp.get(x, 5), 1, "expected a dot at x={x}");
        }
        assert_eq!(bmp.get(1, 5), 0);
        assert_eq!(bmp.get(8, 5), 0);
    }

    #[test]
    fn draws_a_vertical_line() {
        let mut bmp = Bitmap::new(10, 10);
        draw_line(&mut bmp, 3.0, 1.0, 3.0, 8.0);
        for y in 1..=8 {
            assert_eq!(bmp.get(3, y), 1, "expected a dot at y={y}");
        }
    }

    #[test]
    fn draws_a_diagonal_with_no_gaps() {
        let mut bmp = Bitmap::new(10, 10);
        draw_line(&mut bmp, 0.0, 0.0, 9.0, 9.0);
        for i in 0..10 {
            assert_eq!(bmp.get(i, i), 1, "expected a dot at {i},{i}");
        }
    }

    #[test]
    fn a_line_crossing_the_grid_is_drawn_edge_to_edge() {
        let mut bmp = Bitmap::new(10, 10);
        draw_line(&mut bmp, -50.0, 5.0, 50.0, 5.0);
        for x in 0..10 {
            assert_eq!(bmp.get(x, 5), 1);
        }
    }

    #[test]
    fn a_line_that_misses_the_grid_draws_nothing() {
        let mut bmp = Bitmap::new(10, 10);
        draw_line(&mut bmp, -50.0, 500.0, 50.0, 500.0);
        assert_eq!(bmp.count_set(), 0);
    }

    #[test]
    fn a_zero_length_line_sets_one_dot() {
        let mut bmp = Bitmap::new(10, 10);
        draw_line(&mut bmp, 4.0, 4.0, 4.0, 4.0);
        assert_eq!(bmp.count_set(), 1);
        assert_eq!(bmp.get(4, 4), 1);
    }

    #[test]
    fn a_non_finite_line_is_ignored() {
        let mut bmp = Bitmap::new(10, 10);
        draw_line(&mut bmp, f32::NAN, 0.0, 5.0, 5.0);
        assert_eq!(bmp.count_set(), 0);
    }
}
