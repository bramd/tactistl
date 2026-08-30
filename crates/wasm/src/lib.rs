use tactistl_core::transform::ViewAxis;
use tactistl_core::vec::Vec3;
use tactistl_core::{bounds, mesh, render, RenderParams};
use wasm_bindgen::prelude::*;

/// An opaque handle to a parsed mesh, held on the WASM heap so the triangle
/// data never crosses into JavaScript.
#[wasm_bindgen]
pub struct MeshHandle {
    mesh: mesh::Mesh,
}

#[wasm_bindgen]
impl MeshHandle {
    #[wasm_bindgen(getter)]
    pub fn triangle_count(&self) -> usize {
        self.mesh.triangles.len()
    }

    /// The rotated bounds, flattened as
    /// `[min_x, min_y, min_z, max_x, max_y, max_z]`.
    pub fn bounds(&self, rx: f32, ry: f32, rz: f32, view: u8) -> Vec<f32> {
        let b = bounds(&self.mesh, Vec3::new(rx, ry, rz), ViewAxis::from_u8(view));
        if b.is_empty() {
            return vec![0.0; 6];
        }
        vec![b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]
    }

    /// Slice and rasterize in one call. Returns `width * height` bytes, each 0
    /// or 1, row-major from the top-left.
    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &self,
        rx: f32,
        ry: f32,
        rz: f32,
        view: u8,
        z: f32,
        width: usize,
        height: usize,
        filled: bool,
        mirror: bool,
    ) -> Result<Vec<u8>, JsError> {
        // Grid dimensions arrive from a Bluetooth-connected device in a later
        // task, so they are not trusted. Reject implausible values here rather
        // than letting Bitmap::new attempt the allocation: on wasm32 `usize` is
        // 32-bit, and a huge `vec![0; w * h]` aborts the module outright, which
        // the user experiences as a dead page with no error.
        //
        // 512 is deliberately tight: the largest tactile display ever shipped
        // is about 120x60, and the target Dot Pad is 60x40. A loose cap does
        // not just risk an allocation failure — rasterizing millions of cells
        // on every slider tick would freeze the page, which is the same
        // failure arriving by a slower route.
        const MAX_DIM: usize = 512;
        if width == 0 || height == 0 || width > MAX_DIM || height > MAX_DIM {
            return Err(JsError::new(&format!(
                "unsupported display size {width}x{height}"
            )));
        }
        let p = RenderParams {
            rotation_deg: Vec3::new(rx, ry, rz),
            view: ViewAxis::from_u8(view),
            z,
            width,
            height,
            filled,
            mirror,
        };
        Ok(render(&self.mesh, &p).data)
    }
}

/// Parse STL bytes. Rejects with a JS `Error` carrying a human-readable
/// message suitable for showing in the UI.
#[wasm_bindgen]
pub fn parse_stl(bytes: &[u8]) -> Result<MeshHandle, JsError> {
    match mesh::parse_stl(bytes) {
        Ok(mesh) => Ok(MeshHandle { mesh }),
        Err(e) => Err(JsError::new(&e.to_string())),
    }
}
