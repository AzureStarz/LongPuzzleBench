export interface ColorConnectGridGeometry {
    readonly rows: number;
    readonly columns: number;
    readonly pitch: number;
}

export interface ColorConnectGridPoint {
    /** Column-space coordinate; integer values are vertical cell boundaries. */
    readonly x: number;
    /** Row-space coordinate; integer values are horizontal cell boundaries. */
    readonly y: number;
}

export interface ColorConnectGridHit {
    readonly row: number;
    readonly column: number;
    readonly localX: number;
    readonly localY: number;
    readonly centerX: number;
    readonly centerY: number;
    readonly gridPoint: ColorConnectGridPoint;
}

/** Convert a board-local point into continuous row/column space. */
export function colorConnectLocalToGridPoint(
    localX: number,
    localY: number,
    geometry: Readonly<ColorConnectGridGeometry>,
): ColorConnectGridPoint | null {
    if (!Number.isFinite(localX) || !Number.isFinite(localY)
        || !Number.isFinite(geometry.pitch) || geometry.pitch <= 0
        || !Number.isInteger(geometry.rows) || geometry.rows <= 0
        || !Number.isInteger(geometry.columns) || geometry.columns <= 0) {
        return null;
    }
    return {
        x: localX / geometry.pitch + geometry.columns / 2,
        y: geometry.rows / 2 - localY / geometry.pitch,
    };
}

export function isColorConnectGridPointInside(
    point: Readonly<ColorConnectGridPoint>,
    geometry: Readonly<ColorConnectGridGeometry>,
): boolean {
    return point.x >= 0
        && point.x < geometry.columns
        && point.y >= 0
        && point.y < geometry.rows;
}

/**
 * Deterministic board hit test. Internal pitch boundaries belong to the cell
 * on their right/bottom; the board's right and bottom outer edges are outside.
 */
export function hitColorConnectGrid(
    localX: number,
    localY: number,
    geometry: Readonly<ColorConnectGridGeometry>,
): ColorConnectGridHit | null {
    const gridPoint = colorConnectLocalToGridPoint(localX, localY, geometry);
    if (!gridPoint || !isColorConnectGridPointInside(gridPoint, geometry)) return null;
    const row = Math.floor(gridPoint.y);
    const column = Math.floor(gridPoint.x);
    return {
        row,
        column,
        localX,
        localY,
        centerX: (column - (geometry.columns - 1) / 2) * geometry.pitch,
        centerY: ((geometry.rows - 1) / 2 - row) * geometry.pitch,
        gridPoint,
    };
}

export function colorConnectCellCenter(
    row: number,
    column: number,
    geometry: Readonly<ColorConnectGridGeometry>,
): Readonly<{ x: number; y: number }> {
    return {
        x: (column - (geometry.columns - 1) / 2) * geometry.pitch,
        y: ((geometry.rows - 1) / 2 - row) * geometry.pitch,
    };
}
