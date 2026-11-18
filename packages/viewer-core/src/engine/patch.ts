// Turn a geometry patch from the model server (base64 arrays) into IfcMesh
// objects the batcher ingests. Pure: no DOM, no Three.js.
import type { GeometryPatch } from './session.js';
import type { IfcMesh, MeshGeometry } from './types.js';

function decodeBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function asFloat32(base64: string): Float32Array {
  const bytes = decodeBytes(base64);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function asUint32(base64: string): Uint32Array {
  const bytes = decodeBytes(base64);
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** Meshes for a patch; placements whose geometry is missing are skipped. */
export function unpackPatch(patch: GeometryPatch): IfcMesh[] {
  const geometries = new Map<number, { geometry: MeshGeometry; bounds: number[] }>();
  for (const g of patch.geometries) {
    geometries.set(g.id, {
      geometry: { positions: asFloat32(g.positions), normals: asFloat32(g.normals), indices: asUint32(g.indices) },
      bounds: g.bounds,
    });
  }
  const meshes: IfcMesh[] = [];
  for (const p of patch.placements) {
    const entry = geometries.get(p.geometryId);
    if (!entry) continue;
    const b = entry.bounds;
    meshes.push({
      expressID: p.id,
      ifcType: p.ifcType,
      geometryID: p.geometryId,
      geometry: entry.geometry,
      localBounds: { min: { x: b[0], y: b[1], z: b[2] }, max: { x: b[3], y: b[4], z: b[5] } },
      matrix: p.matrix,
      color: { r: p.color[0], g: p.color[1], b: p.color[2], a: p.color[3] },
    });
  }
  return meshes;
}
