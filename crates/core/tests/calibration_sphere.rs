//! Checks on `models/calibration-sphere-20mm.stl`, the model the README's
//! pin-aspect procedure asks you to load.
//!
//! The point of the model is that a human can feel whether the rendered
//! cross-section is as wide as it is tall. These tests pin the properties that
//! make that judgement meaningful: the mesh really is a centred sphere of
//! radius 20, its mid-height slice really is a circle of radius 20 rather than
//! merely something with a 40 x 40 bounding box, and the raster of that circle
//! really does come out equally wide and tall at the assumed `PIN_ASPECT`.
//!
//! Regenerate the model with `cargo run --example make_calibration_sphere`.

use std::collections::HashMap;
use tactistl_core::mesh::{self, Mesh};
use tactistl_core::raster::Bitmap;
use tactistl_core::transform::ViewAxis;
use tactistl_core::vec::{Vec2, Vec3};
use tactistl_core::{bounds, render, slice, RenderParams};

const LONGITUDES: usize = 64;
const LATITUDES: usize = 33;
const RADIUS: f32 = 20.0;

/// 2 * 64 * 32: one triangle per longitude in each cap, two per longitude in
/// each of the 31 quad bands.
const TRIANGLES: usize = 2 * LONGITUDES * (LATITUDES - 1);

/// The sphere is a polyhedron, so its widest ring is not quite at radius 20.
/// `LATITUDES` is odd, so the two rings bounding the equator sit half a
/// latitude step off it, both at this radius.
fn ring_radius() -> f32 {
    RADIUS * (std::f32::consts::PI / (2.0 * LATITUDES as f32)).cos()
}

/// The equatorial cross-section is a `LONGITUDES`-gon of circumradius
/// `ring_radius`; its edge midpoints sit at the inradius. Every point of the
/// cross-section lies between the two.
fn inradius() -> f32 {
    ring_radius() * (std::f32::consts::PI / LONGITUDES as f32).cos()
}

fn sphere() -> Mesh {
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../models/calibration-sphere-20mm.stl"
    ))
    .expect("the calibration sphere is missing; regenerate it with `cargo run --example make_calibration_sphere`");
    mesh::parse_stl(&bytes).expect("the calibration sphere must parse")
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

#[test]
fn the_committed_model_matches_the_generator() {
    assert_eq!(sphere().triangles.len(), TRIANGLES);
}

#[test]
fn the_model_is_a_centred_sphere_of_radius_20() {
    let b = bounds(&sphere(), Vec3::default(), ViewAxis::Top);

    // The poles are placed exactly, so Z hits +/-20 on the nose.
    assert!((b.min.z + RADIUS).abs() < 1e-4, "min z was {}", b.min.z);
    assert!((b.max.z - RADIUS).abs() < 1e-4, "max z was {}", b.max.z);

    // X and Y are bounded by the widest ring, which is 0.023 mm inside the
    // true radius -- about 2% of one dot, so it is invisible on the display,
    // but it is not zero and the tolerance has to say so.
    let r = ring_radius();
    assert!(RADIUS - r < 0.03, "the ring radius {r} drifted from 20");
    for (name, v) in [
        ("min x", b.min.x),
        ("min y", b.min.y),
        ("max x", b.max.x),
        ("max y", b.max.y),
    ] {
        assert!((v.abs() - r).abs() < 1e-3, "{name} was {v}, expected +/-{r}");
    }
}

#[test]
fn the_mesh_is_watertight() {
    // Every directed edge must appear exactly once, which for a closed
    // orientable surface means every edge is shared by exactly two facets with
    // opposite winding. Vertices are compared by their exact bits, so this
    // also catches a seam whose two sides were computed separately and rounded
    // apart into two nearly-equal corners.
    let key = |v: Vec3| [v.x.to_bits(), v.y.to_bits(), v.z.to_bits()];
    let mut edges: HashMap<([u32; 3], [u32; 3]), usize> = HashMap::new();
    for t in &sphere().triangles {
        for i in 0..3 {
            *edges
                .entry((key(t.v[i]), key(t.v[(i + 1) % 3])))
                .or_insert(0) += 1;
        }
    }
    assert_eq!(
        edges.len(),
        3 * TRIANGLES,
        "some directed edge was traversed more than once"
    );
    for (e, n) in &edges {
        assert_eq!(*n, 1, "a directed edge appears {n} times");
        assert!(
            edges.contains_key(&(e.1, e.0)),
            "an edge has no opposite twin, so the surface has a hole"
        );
    }
}

#[test]
fn the_mid_height_slice_is_a_circle_of_radius_20() {
    let m = sphere();
    let b = bounds(&m, Vec3::default(), ViewAxis::Top);
    let mid = (b.min.z + b.max.z) / 2.0;
    let segments = slice::slice(&m, Vec3::default(), ViewAxis::Top, mid);

    // Two per longitude: the equator falls inside a quad band, and both of
    // that band's triangles are cut.
    assert_eq!(segments.len(), 2 * LONGITUDES);

    let (lo, hi) = (inradius(), ring_radius());
    let mut min_r = f32::INFINITY;
    let mut max_r = f32::NEG_INFINITY;
    let (mut min_x, mut max_x) = (f32::INFINITY, f32::NEG_INFINITY);
    let (mut min_y, mut max_y) = (f32::INFINITY, f32::NEG_INFINITY);

    // Sample the endpoints *and* the segment midpoints, so the points tested
    // are spread all the way round rather than clustered on the corners. An
    // extent check alone would be satisfied by a square; this would not be --
    // a 40 x 40 square's corners sit at radius 28.3.
    for s in &segments {
        let mid_point = Vec2 {
            x: (s.a.x + s.b.x) / 2.0,
            y: (s.a.y + s.b.y) / 2.0,
        };
        for p in [s.a, s.b, mid_point] {
            let r = (p.x * p.x + p.y * p.y).sqrt();
            assert!(
                r >= lo - 1e-3 && r <= hi + 1e-3,
                "({}, {}) is at radius {r}, outside the polygon's {lo}..{hi}",
                p.x,
                p.y
            );
            min_r = min_r.min(r);
            max_r = max_r.max(r);
            min_x = min_x.min(p.x);
            max_x = max_x.max(p.x);
            min_y = min_y.min(p.y);
            max_y = max_y.max(p.y);
        }
    }

    // The sampled radii must actually span the polygon, or the bound above
    // would pass on a handful of coincidentally-placed points.
    assert!(
        (min_r - lo).abs() < 1e-3,
        "the inradius was never reached: {min_r}"
    );
    assert!(
        (max_r - hi).abs() < 1e-3,
        "the circumradius was never reached: {max_r}"
    );

    // 40 x 40, to within the polygon's own 0.023 mm shortfall.
    assert!(
        (max_x - min_x - 2.0 * hi).abs() < 1e-3,
        "width was {}",
        max_x - min_x
    );
    assert!(
        (max_y - min_y - 2.0 * hi).abs() < 1e-3,
        "height was {}",
        max_y - min_y
    );
    assert!(
        2.0 * RADIUS - (max_x - min_x) < 0.06,
        "width was {}",
        max_x - min_x
    );
}

/// The inclusive index range of rows, then of columns, holding a set dot.
fn extents(b: &Bitmap) -> ((usize, usize), (usize, usize)) {
    let mut rows = (usize::MAX, 0usize);
    let mut cols = (usize::MAX, 0usize);
    for y in 0..b.height {
        for x in 0..b.width {
            if b.get(x, y) == 1 {
                rows = (rows.0.min(y), rows.1.max(y));
                cols = (cols.0.min(x), cols.1.max(x));
            }
        }
    }
    (rows, cols)
}

#[test]
fn the_rendered_circle_is_as_wide_as_it_is_tall() {
    // This is the property the calibration procedure asks a human to feel.
    // These dot counts agreeing does not prove the *physical* circle is round
    // -- that is what PIN_ASPECT is for -- but if they ever stop agreeing, the
    // fit itself has broken and no amount of feeling will diagnose it.
    let bmp = render(&sphere(), &params());
    assert!(bmp.count_set() > 0, "the calibration sphere rendered blank");

    let ((r0, r1), (c0, c1)) = extents(&bmp);
    let (h, w) = (r1 - r0 + 1, c1 - c0 + 1);
    assert_eq!(w, h, "the circle is {w} dots wide but {h} dots tall");
    // 40 rows, an aspect-preserving fit and a model as wide as it is tall: the
    // circle fills the grid's full height.
    assert_eq!(h, bmp.height);
}

#[test]
fn the_rendered_circle_is_symmetric_about_both_axes() {
    let bmp = render(&sphere(), &params());
    let ((r0, r1), (c0, c1)) = extents(&bmp);

    // Compared row by row rather than dot for dot: the polygon is symmetric,
    // but the line rasterizer's rounding need not reflect exactly, so a
    // dot-for-dot check could fail on a tie that means nothing to a finger.
    let row = |y: usize| {
        let set: Vec<usize> = (0..bmp.width).filter(|&x| bmp.get(x, y) == 1).collect();
        (set.first().copied(), set.last().copied(), set.len())
    };
    for y in r0..=r1 {
        let mirrored = r1 + r0 - y;
        assert_eq!(row(y), row(mirrored), "row {y} differs from row {mirrored}");

        // And left/right within the row: its dots straddle the grid centre.
        if let (Some(lo), Some(hi), _) = row(y) {
            assert_eq!(lo + hi, c0 + c1, "row {y} spans {lo}..{hi}, off centre");
        }
    }
}
