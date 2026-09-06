use std::{env, fs, path::PathBuf};

const SIZE: usize = 256;

fn fill_rect(pixels: &mut [u8], x: usize, y: usize, w: usize, h: usize, rgba: [u8; 4]) {
    for py in y..(y + h).min(SIZE) {
        for px in x..(x + w).min(SIZE) {
            let i = (py * SIZE + px) * 4;
            pixels[i..i + 4].copy_from_slice(&rgba);
        }
    }
}

fn finder(pixels: &mut [u8], x: usize, y: usize) {
    const WHITE: [u8; 4] = [244, 247, 250, 255];
    const DARK: [u8; 4] = [15, 18, 24, 255];
    const MINT: [u8; 4] = [79, 235, 196, 255];
    fill_rect(pixels, x, y, 54, 54, WHITE);
    fill_rect(pixels, x + 7, y + 7, 40, 40, DARK);
    fill_rect(pixels, x + 17, y + 17, 20, 20, MINT);
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in bytes {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

fn adler32(bytes: &[u8]) -> u32 {
    const MOD: u32 = 65_521;
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in bytes {
        a = (a + byte as u32) % MOD;
        b = (b + a) % MOD;
    }
    (b << 16) | a
}

fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

fn stored_zlib(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01];
    let mut offset = 0usize;
    while offset < data.len() {
        let len = (data.len() - offset).min(65_535);
        let final_block = offset + len == data.len();
        out.push(if final_block { 0x01 } else { 0x00 });
        let len16 = len as u16;
        out.extend_from_slice(&len16.to_le_bytes());
        out.extend_from_slice(&(!len16).to_le_bytes());
        out.extend_from_slice(&data[offset..offset + len]);
        offset += len;
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn write_png() -> Vec<u8> {
    const BG: [u8; 4] = [8, 10, 14, 255];
    const WHITE: [u8; 4] = [244, 247, 250, 255];
    const MINT: [u8; 4] = [79, 235, 196, 255];

    let mut pixels = vec![0u8; SIZE * SIZE * 4];
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.copy_from_slice(&BG);
    }
    finder(&mut pixels, 52, 52);
    finder(&mut pixels, 150, 52);
    finder(&mut pixels, 52, 150);

    let modules = [(156, 156), (177, 156), (198, 156), (156, 177), (198, 177), (156, 198), (177, 198), (198, 198)];
    for (index, (x, y)) in modules.into_iter().enumerate() {
        let color = if matches!(index, 0 | 3 | 5 | 7) { MINT } else { WHITE };
        fill_rect(&mut pixels, x, y, 13, 13, color);
    }
    fill_rect(&mut pixels, 118, 118, 20, 20, MINT);

    let mut scanlines = Vec::with_capacity((SIZE * 4 + 1) * SIZE);
    for y in 0..SIZE {
        scanlines.push(0);
        let start = y * SIZE * 4;
        scanlines.extend_from_slice(&pixels[start..start + SIZE * 4]);
    }

    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&(SIZE as u32).to_be_bytes());
    ihdr.extend_from_slice(&(SIZE as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    png_chunk(&mut png, b"IHDR", &ihdr);
    png_chunk(&mut png, b"IDAT", &stored_zlib(&scanlines));
    png_chunk(&mut png, b"IEND", &[]);
    png
}

fn write_ico(png: &[u8]) -> Vec<u8> {
    let mut ico = Vec::with_capacity(22 + png.len());
    ico.extend_from_slice(&0u16.to_le_bytes());
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&[0, 0, 0, 0]); // 0 means 256x256; no palette; reserved.
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&32u16.to_le_bytes());
    ico.extend_from_slice(&(png.len() as u32).to_le_bytes());
    ico.extend_from_slice(&22u32.to_le_bytes());
    ico.extend_from_slice(png);
    ico
}

fn materialize_icons() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let icon_dir = manifest.join("icons");
    fs::create_dir_all(&icon_dir).expect("create Tauri icon directory");
    let png = write_png();
    fs::write(icon_dir.join("icon.png"), &png).expect("write icon.png");
    fs::write(icon_dir.join("icon.ico"), write_ico(&png)).expect("write icon.ico");
}

fn main() {
    materialize_icons();
    println!("cargo:rerun-if-changed=build.rs");
    tauri_build::build();
}
