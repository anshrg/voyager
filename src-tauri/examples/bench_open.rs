//! Benchmark FitsFile::open on an arbitrary file.
//! Usage: cargo run --release --example bench_open -- /path/to/file.fits

use ds10_lib::fits::FitsFile;
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).expect("usage: bench_open <file.fits>");
    let t0 = Instant::now();
    let file = FitsFile::open(std::path::Path::new(&path)).expect("open failed");
    let dt = t0.elapsed();
    println!(
        "opened {} ({:.2} GiB) in {:.2} ms — {} HDUs",
        path,
        file.size as f64 / (1u64 << 30) as f64,
        dt.as_secs_f64() * 1e3,
        file.hdus.len()
    );
    for hdu in &file.hdus {
        println!(
            "  HDU {}: {:?} {:?} bitpix={} shape={:?} data={} B",
            hdu.index, hdu.kind, hdu.name, hdu.bitpix, hdu.shape, hdu.data_len
        );
    }
    // Touch a few pixels to prove data access works without a full read.
    if let Some(hdu) = file.hdus.iter().find(|h| h.shape.len() == 2) {
        let (nx, ny) = (hdu.shape[0] as u64, hdu.shape[1] as u64);
        let t1 = Instant::now();
        let corner = file.pixel_value(hdu.index, 0, 0).unwrap();
        let center = file.pixel_value(hdu.index, nx / 2, ny / 2).unwrap();
        let far = file.pixel_value(hdu.index, nx - 1, ny - 1).unwrap();
        println!(
            "  spot reads (corner={corner:.3}, center={center:.3}, far={far:.3}) in {:.2} ms",
            t1.elapsed().as_secs_f64() * 1e3
        );
    }
}
