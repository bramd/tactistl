pub mod fill;
pub mod fit;
pub mod outline;

/// A device-agnostic dot grid. One byte per dot, 0 or 1, row-major from the
/// top-left. This is the hand-off point to any tactile output backend.
#[derive(Debug, Clone, PartialEq)]
pub struct Bitmap {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

impl Bitmap {
    pub fn new(width: usize, height: usize) -> Bitmap {
        Bitmap { width, height, data: vec![0; width * height] }
    }

    /// Panics on coordinates outside the grid, unlike `set`, which ignores
    /// them. A caller crossing a device boundary must bounds-check first: an
    /// out-of-range read from a display backend would surface as an
    /// unrecoverable WASM trap, not an error message.
    pub fn get(&self, x: usize, y: usize) -> u8 {
        self.data[y * self.width + x]
    }

    /// Sets a dot, ignoring coordinates outside the grid.
    pub fn set(&mut self, x: i32, y: i32) {
        if x < 0 || y < 0 {
            return;
        }
        let (x, y) = (x as usize, y as usize);
        if x >= self.width || y >= self.height {
            return;
        }
        self.data[y * self.width + x] = 1;
    }

    pub fn count_set(&self) -> usize {
        self.data.iter().filter(|&&d| d == 1).count()
    }

    /// Reflect left-to-right, in place.
    ///
    /// Mirroring happens here rather than in the coordinate mapping so that it
    /// is an exact reflection: flipping coordinates before rounding would
    /// disagree with a true reflection wherever a coordinate lands on a
    /// half-integer.
    pub fn mirror_horizontal(&mut self) {
        for y in 0..self.height {
            let row = y * self.width;
            for x in 0..self.width / 2 {
                self.data.swap(row + x, row + self.width - 1 - x);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirror_horizontal_is_an_exact_reflection() {
        let mut b = Bitmap::new(5, 2);
        b.set(0, 0);
        b.set(1, 1);
        let original = b.clone();
        b.mirror_horizontal();
        assert_eq!(b.get(4, 0), 1);
        assert_eq!(b.get(0, 0), 0);
        assert_eq!(b.get(3, 1), 1);
        // Reflecting twice returns the original.
        b.mirror_horizontal();
        assert_eq!(b, original);
    }

    #[test]
    fn mirror_horizontal_preserves_the_dot_count() {
        let mut b = Bitmap::new(7, 3);
        b.set(0, 0);
        b.set(3, 1);
        b.set(6, 2);
        b.mirror_horizontal();
        assert_eq!(b.count_set(), 3);
        // An odd width leaves the centre column in place.
        assert_eq!(b.get(3, 1), 1);
    }
}
