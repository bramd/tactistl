// Regenerates the binary STL fixture from the ASCII one.
//
// Known limitation: the fixture is produced by `stl_io`'s own writer, so it
// cannot catch a bug shared between that writer and its binary reader.

use std::fs::File;

fn main() {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/cube_ascii.stl")).unwrap();
    let mut cursor = std::io::Cursor::new(bytes);
    let mesh = stl_io::read_stl(&mut cursor).unwrap();
    let tris: Vec<stl_io::Triangle> = mesh
        .faces
        .iter()
        .map(|f| stl_io::Triangle {
            normal: f.normal,
            vertices: [
                mesh.vertices[f.vertices[0]],
                mesh.vertices[f.vertices[1]],
                mesh.vertices[f.vertices[2]],
            ],
        })
        .collect();
    let mut out = File::create(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/cube_binary.stl")).unwrap();
    stl_io::write_stl(&mut out, tris.iter()).unwrap();
}
