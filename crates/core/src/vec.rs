#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }
}

/// Row-major 3x3 matrix. `m[row][col]`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mat3(pub [[f32; 3]; 3]);

impl Mat3 {
    pub fn identity() -> Self {
        Mat3([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
    }

    pub fn mul(&self, other: &Mat3) -> Mat3 {
        let mut out = [[0.0f32; 3]; 3];
        for r in 0..3 {
            for c in 0..3 {
                out[r][c] = (0..3).map(|k| self.0[r][k] * other.0[k][c]).sum();
            }
        }
        Mat3(out)
    }

    pub fn apply(&self, v: Vec3) -> Vec3 {
        let m = &self.0;
        Vec3 {
            x: m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
            y: m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
            z: m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bbox3 {
    pub min: Vec3,
    pub max: Vec3,
}

impl Bbox3 {
    /// An empty box that grows correctly on the first `include`.
    pub fn empty() -> Self {
        Bbox3 {
            min: Vec3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY),
            max: Vec3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY),
        }
    }

    pub fn include(&mut self, v: Vec3) {
        self.min.x = self.min.x.min(v.x);
        self.min.y = self.min.y.min(v.y);
        self.min.z = self.min.z.min(v.z);
        self.max.x = self.max.x.max(v.x);
        self.max.y = self.max.y.max(v.y);
        self.max.z = self.max.z.max(v.z);
    }

    pub fn is_empty(&self) -> bool {
        self.min.x > self.max.x
    }
}
