use crate::raster::Bitmap;
use crate::slice::Segment;

/// Even-odd scanline fill over a segment soup in *grid* coordinates.
///
/// An edge is counted for row `y` when exactly one of its endpoints is at or
/// above `y`. This half-open rule counts a shared vertex once rather than
/// twice, and drops exactly-horizontal edges, both of which would otherwise
/// corrupt the parity.
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

        if crossings.len() < 2 {
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

    #[test]
    fn an_empty_segment_list_fills_nothing() {
        let mut bmp = Bitmap::new(10, 10);
        fill_scanlines(&mut bmp, &[]);
        assert_eq!(bmp.count_set(), 0);
    }
}
