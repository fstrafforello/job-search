// Minimal edits to a Windows PE (.exe) file's headers.
import fs from 'node:fs';

function headers(buf) {
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('Not a PE file');
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const dataDirs = opt + (magic === 0x20b ? 112 : 96); // PE32+ vs PE32
  return { subsystem: opt + 68, security: dataDirs + 4 * 8 };
}

// Windows GUI subsystem: the exe starts without opening a console window.
export function setGuiSubsystem(file) {
  const buf = fs.readFileSync(file);
  buf.writeUInt16LE(2, headers(buf).subsystem);
  fs.writeFileSync(file, buf);
}

// Drops the Authenticode signature (node.exe is signed by the Node.js project). Once the exe
// is modified that signature is invalid, and an unsigned exe looks better to Windows than a broken one.
export function stripSignature(file) {
  const buf = fs.readFileSync(file);
  const { security } = headers(buf);
  const offset = buf.readUInt32LE(security);
  const size = buf.readUInt32LE(security + 4);
  if (!offset) return;
  buf.writeUInt32LE(0, security);
  buf.writeUInt32LE(0, security + 4);
  fs.writeFileSync(file, offset + size === buf.length ? buf.subarray(0, offset) : buf);
}
