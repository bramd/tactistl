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

/// A chunk-fed STL parser: construct with the file's size, `push` each chunk
/// of `file.stream()`, then `finish`.
///
/// This is a heap object with a `free()`. The caller MUST free it on every
/// path, failure included — a rejected parse that skips the free leaks its
/// buffer into linear memory permanently, because wasm32 memory never shrinks.
#[wasm_bindgen]
pub struct StlStream {
    // `Option` so `finish` can take the parser out through `&mut self` rather
    // than consuming `self`. wasm-bindgen's consumed-self semantics neuter the
    // JS handle, and the caller then cannot tell whether it still owes a
    // `free()`; with an `Option` the answer is always "yes, unconditionally".
    inner: Option<mesh::StreamParser>,
}

#[wasm_bindgen]
impl StlStream {
    /// `total_len` is the file's size in bytes — `File.size`, which costs no
    /// reading. It arrives as a JS number, i.e. an `f64`, so it is validated
    /// here rather than being cast into a nonsense `usize`.
    #[wasm_bindgen(constructor)]
    pub fn new(total_len: f64) -> Result<StlStream, JsError> {
        // On wasm32 `usize` is 32-bit, so anything at or above 4 GiB cannot be
        // a length here at all; and a negative, fractional or non-finite value
        // is a caller bug, not a file we should try to read.
        //
        // The sentences come from `core` rather than being written out here.
        // They are the same ones `ParseError` displays, they are read aloud by
        // a screen reader, and a copy in each crate is a copy that eventually
        // stops matching. This crate already depends on `core`, so the shared
        // definition costs nothing.
        if !total_len.is_finite() || total_len < 0.0 || total_len.fract() != 0.0 {
            return Err(JsError::new(mesh::MSG_UNREADABLE));
        }
        if total_len > usize::MAX as f64 {
            return Err(JsError::new(mesh::MSG_TOO_LARGE));
        }
        Ok(StlStream {
            inner: Some(mesh::StreamParser::new(total_len as usize)),
        })
    }

    /// Feed the next chunk of the file.
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), JsError> {
        let parser = self
            .inner
            .as_mut()
            .ok_or_else(|| JsError::new(mesh::MSG_UNREADABLE))?;
        parser.push(chunk).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Take the finished mesh. The stream is spent afterwards, but the handle
    /// still has to be freed.
    pub fn finish(&mut self) -> Result<MeshHandle, JsError> {
        let parser = self
            .inner
            .take()
            .ok_or_else(|| JsError::new(mesh::MSG_UNREADABLE))?;
        match parser.finish() {
            Ok(mesh) => Ok(MeshHandle { mesh }),
            Err(e) => Err(JsError::new(&e.to_string())),
        }
    }
}
