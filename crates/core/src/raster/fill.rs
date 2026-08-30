use crate::raster::Bitmap;
use crate::slice::Segment;

/// Even-odd scanline fill over a segment soup in *grid* coordinates.
///
/// An edge is counted for row `y` when exactly one of its endpoints is at or
/// above `y`. This half-open rule counts a shared vertex once rather than
/// twice, and drops exactly-horizontal edges, both of which would otherwise
/// corrupt the parity.
///
/// A row whose crossing count comes out odd is skipped rather than filled —
/// see the comment on that check for why guessing is worse than abstaining.
pub fn fill_scanlines(bmp: &mut Bitmap, segments: &[Segment]) {
    if segments.is_empty() {
        return;
    }
    let mut crossings: Vec<f32> = Vec::new();

    for row in 0..bmp.height {
        let y = row as f32;
        crossings.clear();

        for s in segments {
            let (ya, yb) = (s.a.y, s.b.y);
            if !(ya.is_finite() && yb.is_finite() && s.a.x.is_finite() && s.b.x.is_finite()) {
                continue;
            }
            if (ya <= y) == (yb <= y) {
                continue;
            }
            let t = (y - ya) / (yb - ya);
            crossings.push(s.a.x + t * (s.b.x - s.a.x));
        }

        // An odd count means the contour is open on this row — a non-watertight
        // mesh, or a segment dropped by the non-finite filter above. Because
        // sorting merges the crossings of every contour into one list, pairing
        // an odd list anyway does not merely lose the unmatched crossing: it
        // shifts the pairing and inverts the fill for every span to its right.
        // Measured on a closed square with one dangling edge, that dropped half
        // the interior; with the stray crossing to the left of the shape, it
        // filled a region outside the shape and left the interior empty.
        //
        // So the row is skipped. For an open contour "which side is inside" has
        // no answer, and an inverted span is worse than a missing one: absence
        // reads as absence under the fingers, whereas a wrong shape reads as
        // real geometry. The boundary still comes through, because `render`
        // unions the outline over the fill in filled mode for exactly this
        // reason.
        if crossings.len() < 2 || !crossings.len().is_multiple_of(2) {
            continue;
        }
        crossings.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        for pair in crossings.chunks_exact(2) {
            let from = pair[0].ceil() as i32;
            let to = pair[1].floor() as i32;
            for x in from..=to {
                bmp.set(x, row as i32);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::raster::Bitmap;
    use crate::slice::Segment;
    use crate::vec::Vec2;

    /// A closed square loop in grid coordinates.
    fn square(x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<Segment> {
        let p = |x, y| Vec2 { x, y };
        vec![
            Segment { a: p(x0, y0), b: p(x1, y0) },
            Segment { a: p(x1, y0), b: p(x1, y1) },
            Segment { a: p(x1, y1), b: p(x0, y1) },
            Segment { a: p(x0, y1), b: p(x0, y0) },
        ]
    }

    #[test]
    fn fills_the_interior_of_a_square() {
        let mut bmp = Bitmap::new(10, 10);
        fill_scanlines(&mut bmp, &square(2.0, 2.0, 8.0, 8.0));
        assert_eq!(bmp.get(5, 5), 1, "the centre must be filled");
        assert_eq!(bmp.get(0, 0), 0, "outside must stay empty");
        assert_eq!(bmp.get(9, 9), 0);
    }

    #[test]
    fn leaves_a_hole_unfilled() {
        // An outer square with an inner square: parity makes the inner one a
        // hole with no special-casing.
        let mut segs = square(1.0, 1.0, 9.0, 9.0);
        segs.extend(square(4.0, 4.0, 6.0, 6.0));
        let mut bmp = Bitmap::new(10, 10);
        fill_scanlines(&mut bmp, &segs);
        assert_eq!(bmp.get(2, 5), 1, "between the squares must be filled");
        assert_eq!(bmp.get(5, 5), 0, "the hole must stay empty");
    }

    #[test]
    fn fills_two_disjoint_regions() {
        let mut segs = square(1.0, 1.0, 3.0, 8.0);
        segs.extend(square(6.0, 1.0, 8.0, 8.0));
        let mut bmp = Bitmap::new(10, 10);
        fill_scanlines(&mut bmp, &segs);
        assert_eq!(bmp.get(2, 5), 1, "left region");
        assert_eq!(bmp.get(7, 5), 1, "right region");
        assert_eq!(bmp.get(5, 5), 0, "the gap between them");
    }

    #[test]
    fn horizontal_edges_do_not_break_parity() {
        // The top and bottom edges of the square are exactly horizontal. Under
        // a naive crossing rule they would be counted and corrupt the fill.
        let mut bmp = Bitmap::new(10, 10);
        fill_scanlines(&mut bmp, &square(2.0, 2.0, 8.0, 8.0));
        for y in 3..8 {
            assert_eq!(bmp.get(5, y), 1, "row {y} must be filled");
        }
    }

    /// The x positions filled on one row.
    fn filled_xs(bmp: &Bitmap, y: usize) -> Vec<usize> {
        (0..bmp.width).filter(|&x| bmp.get(x, y) == 1).collect()
    }

    /// A vertical open edge, the kind a non-watertight mesh contributes.
    fn dangling(x: f32, y0: f32, y1: f32) -> Segment {
        Segment { a: Vec2 { x, y: y0 }, b: Vec2 { x, y: y1 } }
    }

    #[test]
    fn an_odd_crossing_count_skips_the_row_rather_than_mis_pairing_it() {
        // A closed square with a dangling open edge down its middle. On the
        // rows that edge crosses the count is odd, and pairing them anyway
        // filled only x=1..=5 and silently dropped the square's right half.
        let mut segs = square(1.0, 1.0, 9.0, 9.0);
        segs.push(dangling(5.0, 3.0, 7.0));
        let mut bmp = Bitmap::new(12, 12);
        fill_scanlines(&mut bmp, &segs);

        // Rows 3..=6 see the dangling edge, so they are left empty.
        for y in 3..=6 {
            assert_eq!(filled_xs(&bmp, y), Vec::<usize>::new(), "row {y}");
        }
        // Rows it misses still fill correctly: skipping odd rows must not
        // disable filling generally.
        assert_eq!(filled_xs(&bmp, 2), (1..=9).collect::<Vec<usize>>());
        assert_eq!(filled_xs(&bmp, 7), (1..=9).collect::<Vec<usize>>());
    }

    #[test]
    fn a_stray_crossing_left_of_a_shape_never_fills_outside_it() {
        // The stray edge sorts before both of the square's crossings, so
        // mis-pairing filled x=1..=3 — outside the shape entirely — and left
        // the real interior empty. Filling the wrong region is worse than
        // filling none: the user would read it as real geometry.
        let mut segs = square(3.0, 1.0, 9.0, 9.0);
        segs.push(dangling(1.0, 3.0, 7.0));
        let mut bmp = Bitmap::new(12, 12);
        fill_scanlines(&mut bmp, &segs);

        for y in 3..=6 {
            assert_eq!(filled_xs(&bmp, y), Vec::<usize>::new(), "row {y}");
        }
        assert_eq!(filled_xs(&bmp, 2), (3..=9).collect::<Vec<usize>>());
    }

    #[test]
    fn an_empty_segment_list_fills_nothing() {
        let mut bmp = Bitmap::new(10, 10);
        fill_scanlines(&mut bmp, &[]);
        assert_eq!(bmp.count_set(), 0);
    }
}
