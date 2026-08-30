// Generates `models/calibration-sphere-20mm.stl`, the model used to check
// whether `raster::fit::PIN_ASPECT` matches the hardware. See the README's
// notes on the device for how to read the result with your fingers.
//
// A sphere of radius exactly 20 mm, centred exactly on the origin, so the
// mid-height slice is the equator and therefore a great circle: the widest
// cross-section the model has, and the same circle regardless of which axis
// you look down.
//
// # Why these segment counts
//
// The grid is 60x40 dots and the fit is aspect-preserving, so a 40 mm model
// is limited by the 40 rows and lands about 39 dots across — one dot is
// roughly 40/39 = 1.03 mm. A facet is invisible when its deviation from the
// true circle is well under half a dot, i.e. well under 0.5 mm.
//
// * `LONGITUDES = 64`. The equator becomes a 64-gon, whose largest deviation
//   from the circle is the sagitta r(1 - cos(pi/n)) = 0.024 mm, about 0.02 of
//   a dot. That is roughly 20x below the visibility threshold, which leaves
//   margin for rotated views, where the outline is not the equator and the
//   rasterizer's rounding is less kind. 32 would already be adequate at 0.09
//   dots; 64 buys the margin for a 200 KB file, which is cheap.
//
// * `LATITUDES = 33`. About half the longitude count, so the triangles are
//   near-equilateral rather than long slivers, and — the reason it is odd
//   rather than 32 — no ring of vertices lands on the equator. A vertex ring
//   sitting exactly in the slice plane would make the cross-section depend on
//   the slicer's on-plane tie-break, which is a fragile thing for a
//   calibration target to depend on. With an odd count the equator falls in
//   the middle of a band whose two bounding rings have the *same* radius, so
//   the cross-section is identical anywhere in that band (z = -0.95..0.95 mm,
//   nearly a whole dot row). The scrubber does not have to be exactly centred.
//
// That gives 2 * 64 * 32 = 4096 triangles.

use std::fs::File;

const RADIUS: f64 = 20.0;
const LONGITUDES: usize = 64;
const LATITUDES: usize = 33;

/// A normal pointing away from the origin, which for a sphere centred on the
/// origin is the outward normal at the facet's centroid.
fn outward_normal(v: [[f64; 3]; 3]) -> stl_io::Normal {
    let c = [
        (v[0][0] + v[1][0] + v[2][0]) / 3.0,
        (v[0][1] + v[1][1] + v[2][1]) / 3.0,
        (v[0][2] + v[1][2] + v[2][2]) / 3.0,
    ];
    let len = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
    stl_io::Normal::new([
        (c[0] / len) as f32,
        (c[1] / len) as f32,
        (c[2] / len) as f32,
    ])
}

fn tri(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> stl_io::Triangle {
    let vertex = |p: [f64; 3]| stl_io::Vertex::new([p[0] as f32, p[1] as f32, p[2] as f32]);
    stl_io::Triangle {
        normal: outward_normal([a, b, c]),
        vertices: [vertex(a), vertex(b), vertex(c)],
    }
}

fn main() {
    // Every vertex is computed exactly once and then referenced by index, so
    // shared corners are bit-identical and the mesh is watertight. In
    // particular the seam at longitude 0 wraps with `(j + 1) % LONGITUDES`
    // rather than evaluating the angle 2*pi as a second copy of 0.
    let north = [0.0, 0.0, RADIUS];
    let south = [0.0, 0.0, -RADIUS];

    // Rings 1..LATITUDES-1; the poles stand in for rings 0 and LATITUDES.
    let rings: Vec<Vec<[f64; 3]>> = (1..LATITUDES)
        .map(|i| {
            let theta = std::f64::consts::PI * i as f64 / LATITUDES as f64;
            let (z, r) = (RADIUS * theta.cos(), RADIUS * theta.sin());
            (0..LONGITUDES)
                .map(|j| {
                    let phi = std::f64::consts::TAU * j as f64 / LONGITUDES as f64;
                    [r * phi.cos(), r * phi.sin(), z]
                })
                .collect()
        })
        .collect();

    let mut tris = Vec::with_capacity(2 * LONGITUDES * (LATITUDES - 1));

    // North cap: real triangles meeting at the pole, not degenerate quads.
    let first = &rings[0];
    for j in 0..LONGITUDES {
        tris.push(tri(north, first[j], first[(j + 1) % LONGITUDES]));
    }

    // Quad bands, each split into two triangles.
    for band in rings.windows(2) {
        let (upper, lower) = (&band[0], &band[1]);
        for j in 0..LONGITUDES {
            let k = (j + 1) % LONGITUDES;
            tris.push(tri(upper[j], lower[j], lower[k]));
            tris.push(tri(upper[j], lower[k], upper[k]));
        }
    }

    // South cap, wound the other way so its normals also point outward.
    let last = &rings[rings.len() - 1];
    for j in 0..LONGITUDES {
        tris.push(tri(last[j], south, last[(j + 1) % LONGITUDES]));
    }

    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../models");
    std::fs::create_dir_all(dir).unwrap();
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../models/calibration-sphere-20mm.stl");
    let mut out = File::create(path).unwrap();
    stl_io::write_stl(&mut out, tris.iter()).unwrap();
    println!("wrote {} triangles to {path}", tris.len());
}
