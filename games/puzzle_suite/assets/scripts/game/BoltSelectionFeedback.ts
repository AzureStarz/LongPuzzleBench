/**
 * Rendering-only selection geometry for the screw puzzle.
 *
 * Keeping these values and calculations free of Cocos types makes the
 * non-accumulating position contract easy to regression-test under Node.
 */
export const BOLT_SELECTION_LIFT = 26;
export const BOLT_SELECTION_DURATION_SECONDS = 0.20;
export const BOLT_SELECTION_SCALE = 1.06;

export interface PositionLike {
    x: number;
    y: number;
    z?: number;
}

export function boltSelectionTarget(
    defaultPosition: PositionLike,
    occupied: boolean,
    selected: boolean,
): Required<PositionLike> {
    return {
        x: defaultPosition.x,
        y: defaultPosition.y + (occupied && selected ? BOLT_SELECTION_LIFT : 0),
        z: defaultPosition.z ?? 0,
    };
}
