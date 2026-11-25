// Depth Lidar helper: decodes the range / intensity rasters of Artec Ray II (Leica RTC360 based)
// raw scan slices with the JPEG XR / JPEG codecs built into Windows (WIC), keeps every Nth
// sample and writes a compact binary file. Compiled at run time by raydecode.ps1 (Add-Type),
// so keep it C# 5 compatible and ASCII-only.
//
// The slice layout below was worked out from the user's own scan data files only:
//   "SCRV8" | i32 108 | i32 lines | i32 jxrLen | i32 width | i32 lines | i32 0x00200001 | JPEG XR (range)
//   i32 width | i32 lines | i32 0 | i32 jpgLen | JPEG (intensity, 8 bit gray)
//   ... further blocks that are not used here
//
// Output file:
//   i32 'RAY1' | i32 sampleStep | i32 lineStep | i32 samplesPerLine | i32 keptLines | i32 fullWidth | i32 totalLines
//   then per kept line: i32 globalLineIndex | i32[samplesPerLine] rawRange | u8[samplesPerLine] intensity
using System;
using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Media.Imaging;

public static class RayDecode
{
    public static void Run(string listFile, string outFile, int sampleStep, int lineStep)
    {
        if (sampleStep < 1) sampleStep = 1;
        if (lineStep < 1) lineStep = 1;
        string[] files = File.ReadAllLines(listFile, Encoding.UTF8);
        int globalLine = 0, kept = 0, nSub = 0, fullWidth = 0;
        using (FileStream fs = new FileStream(outFile, FileMode.Create, FileAccess.ReadWrite))
        using (BinaryWriter w = new BinaryWriter(fs))
        {
            for (int k = 0; k < 7; k++) w.Write(0);
            int[] rowRange = null;
            byte[] rowBytes = null;
            byte[] rowInt = null;
            byte[] outInt = null;
            for (int fi = 0; fi < files.Length; fi++)
            {
                string path = files[fi].Trim();
                if (path.Length == 0) continue;
                byte[] b = File.ReadAllBytes(path);
                if (b.Length < 64 || b[0] != (byte)'S' || b[1] != (byte)'C' || b[2] != (byte)'R' || b[3] != (byte)'V')
                    throw new InvalidDataException("not a scan slice: " + path);
                int jxrLen = BitConverter.ToInt32(b, 13);
                int width = BitConverter.ToInt32(b, 17);
                int lines = BitConverter.ToInt32(b, 21);
                int jxrOff = 29;
                if (width <= 0 || lines <= 0 || jxrLen <= 0 || jxrOff + jxrLen + 16 > b.Length)
                    throw new InvalidDataException("unexpected slice header: " + path);
                if (fullWidth == 0)
                {
                    fullWidth = width;
                    nSub = (width + sampleStep - 1) / sampleStep;
                    rowRange = new int[width];
                    rowBytes = new byte[nSub * 4];
                    rowInt = new byte[width];
                    outInt = new byte[nSub];
                }
                else if (width != fullWidth) throw new InvalidDataException("slice width changed: " + path);

                BitmapFrame range;
                using (MemoryStream ms = new MemoryStream(b, jxrOff, jxrLen, false))
                {
                    WmpBitmapDecoder dec = new WmpBitmapDecoder(ms, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
                    range = dec.Frames[0];
                }
                if (range.PixelWidth != width || range.PixelHeight != lines || range.Format.BitsPerPixel != 32)
                    throw new InvalidDataException("unexpected range image: " + path);

                BitmapSource inten = null;
                int o2 = jxrOff + jxrLen;
                int jpgLen = BitConverter.ToInt32(b, o2 + 12);
                if (BitConverter.ToInt32(b, o2) == width && jpgLen > 0 && o2 + 16 + jpgLen <= b.Length
                    && b[o2 + 16] == 0xFF && b[o2 + 17] == 0xD8)
                {
                    try
                    {
                        using (MemoryStream ms = new MemoryStream(b, o2 + 16, jpgLen, false))
                        {
                            JpegBitmapDecoder jd = new JpegBitmapDecoder(ms, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
                            BitmapSource f = jd.Frames[0];
                            if (f.PixelWidth == width && f.PixelHeight == lines)
                            {
                                if (f.Format.BitsPerPixel != 8)
                                    f = new FormatConvertedBitmap(f, System.Windows.Media.PixelFormats.Gray8, null, 0);
                                inten = f;
                            }
                        }
                    }
                    catch (Exception) { inten = null; }
                }

                for (int row = 0; row < lines; row++, globalLine++)
                {
                    if (globalLine % lineStep != 0) continue;
                    range.CopyPixels(new Int32Rect(0, row, width, 1), rowRange, width * 4, 0);
                    for (int i = 0, j = 0; j < nSub; i += sampleStep, j++)
                    {
                        int v = rowRange[i];
                        rowBytes[j * 4] = (byte)v;
                        rowBytes[j * 4 + 1] = (byte)(v >> 8);
                        rowBytes[j * 4 + 2] = (byte)(v >> 16);
                        rowBytes[j * 4 + 3] = (byte)(v >> 24);
                    }
                    if (inten != null)
                    {
                        inten.CopyPixels(new Int32Rect(0, row, width, 1), rowInt, width, 0);
                        for (int i = 0, j = 0; j < nSub; i += sampleStep, j++) outInt[j] = rowInt[i];
                    }
                    else
                    {
                        for (int j = 0; j < nSub; j++) outInt[j] = 200;
                    }
                    w.Write(globalLine);
                    w.Write(rowBytes, 0, nSub * 4);
                    w.Write(outInt, 0, nSub);
                    kept++;
                }
                Console.WriteLine("P " + (fi + 1) + " " + files.Length);
                Console.Out.Flush();
            }
            w.Flush();
            fs.Seek(0, SeekOrigin.Begin);
            w.Write(0x31594152);
            w.Write(sampleStep);
            w.Write(lineStep);
            w.Write(nSub);
            w.Write(kept);
            w.Write(fullWidth);
            w.Write(globalLine);
            w.Flush();
        }
        Console.WriteLine("DONE " + kept + " " + nSub);
    }

    // Decodes every JPEG XR face stored in a .cubemap file (32 bit gray, fixed point or float) and
    // writes: i32 'RAYC' | i32 faceCount | per face: 4 ASCII chars name | i32 width | i32 height | i32 isFloat | raw 4 bytes per pixel.
    // "step" keeps every Nth pixel in both directions.
    public static void Cube(string file, string outFile, int step)
    {
        if (step < 1) step = 1;
        byte[] b = File.ReadAllBytes(file);
        int count = 0;
        using (FileStream fs = new FileStream(outFile, FileMode.Create, FileAccess.ReadWrite))
        using (BinaryWriter w = new BinaryWriter(fs))
        {
            w.Write(0x43594152);
            w.Write(0);
            for (int pos = 0; pos + 16 < b.Length; pos++)
            {
                if (b[pos] != 0x49 || b[pos + 1] != 0x49 || b[pos + 2] != 0xBC || b[pos + 3] != 0x01) continue;
                // face name: "PosX".."NegZ" shortly before the image
                string name = "????";
                for (int q = pos - 4; q >= 0 && q >= pos - 40; q--)
                {
                    if ((b[q] == (byte)'P' && b[q + 1] == (byte)'o' && b[q + 2] == (byte)'s') || (b[q] == (byte)'N' && b[q + 1] == (byte)'e' && b[q + 2] == (byte)'g'))
                    {
                        name = Encoding.ASCII.GetString(b, q, 4);
                        break;
                    }
                }
                // pixel format GUID ends with 0x11 for 32bpp gray float, 0x3F for 32bpp gray fixed point
                int ifd = BitConverter.ToInt32(b, pos + 4);
                if (ifd <= 0 || pos + ifd + 2 > b.Length) continue;
                int entries = BitConverter.ToUInt16(b, pos + ifd);
                int isFloat = 0, imgOff = 0, imgLen = 0;
                for (int e = 0; e < entries; e++)
                {
                    int at = pos + ifd + 2 + e * 12;
                    if (at + 12 > b.Length) break;
                    int tag = BitConverter.ToUInt16(b, at);
                    int val = BitConverter.ToInt32(b, at + 8);
                    if (tag == 0xBC01 && pos + val + 15 < b.Length && b[pos + val + 15] == 0x11) isFloat = 1;
                    if (tag == 0xBCC0) imgOff = val;
                    if (tag == 0xBCC1) imgLen = val;
                }
                if (imgOff <= 0 || imgLen <= 0 || pos + imgOff + imgLen > b.Length) continue;
                BitmapFrame fr;
                try
                {
                    // the decoder needs a stream that ends exactly where this image ends
                    using (MemoryStream ms = new MemoryStream(b, pos, imgOff + imgLen, false))
                    {
                        WmpBitmapDecoder dec = new WmpBitmapDecoder(ms, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
                        fr = dec.Frames[0];
                    }
                }
                catch (Exception ex) { Console.Error.WriteLine("WARN face at " + pos + ": " + ex.Message); continue; }
                if (fr.Format.BitsPerPixel != 32) { Console.Error.WriteLine("WARN face at " + pos + ": bpp " + fr.Format.BitsPerPixel); continue; }
                int width = fr.PixelWidth, height = fr.PixelHeight;
                int ow = (width + step - 1) / step, oh = (height + step - 1) / step;
                byte[] row = new byte[width * 4];
                byte[] outRow = new byte[ow * 4];
                w.Write(Encoding.ASCII.GetBytes(name));
                w.Write(ow);
                w.Write(oh);
                w.Write(isFloat);
                for (int y = 0; y < height; y += step)
                {
                    fr.CopyPixels(new Int32Rect(0, y, width, 1), row, width * 4, 0);
                    for (int x = 0, j = 0; j < ow; x += step, j++) Buffer.BlockCopy(row, x * 4, outRow, j * 4, 4);
                    w.Write(outRow);
                }
                count++;
                if (imgOff > 0 && imgLen > 0) pos += imgOff + imgLen - 1;
            }
            w.Flush();
            fs.Seek(4, SeekOrigin.Begin);
            w.Write(count);
            w.Flush();
        }
        Console.WriteLine("DONE " + count);
    }
}
