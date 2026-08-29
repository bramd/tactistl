use std::fs::File;

fn main() {
    let bytes = std::fs::read("tests/fixtures/cube_ascii.stl").unwrap();
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
    let mut out = File::create("tests/fixtures/cube_binary.stl").unwrap();
    stl_io::write_stl(&mut out, tris.iter()).unwrap();
}
