/** Degrees of tilt away from the resting pose that move the scene all the way to one side. */
export const TILT_RANGE = 18;

/** Share of the gap to the current pose the resting pose closes each reading, so a new grip recentres. */
export const TILT_SETTLE = 0.01;

/** The phone's pose: `beta` front-to-back and `gamma` left-to-right, in degrees (DeviceOrientationEvent). */
export type Pose = { beta: number; gamma: number };

// `|| 0` turns -0 into 0.
const clamp = (v: number) => Math.max(-1, Math.min(1, v)) || 0;

/**
 * The parallax offset for a pose, in the same -1..1 terms as the pointer (x right, y down),
 * measured from the resting pose and turned with the screen (`angle`, screen.orientation.angle),
 * so tilting the right edge down moves the scene as the pointer moving right would.
 */
export function tiltOffset(pose: Pose, rest: Pose, angle: number): { x: number; y: number } {
  const db = (pose.beta - rest.beta) / TILT_RANGE;
  const dg = (pose.gamma - rest.gamma) / TILT_RANGE;
  switch (((angle % 360) + 360) % 360) {
    case 90:
      return { x: clamp(db), y: clamp(-dg) };
    case 180:
      return { x: clamp(-dg), y: clamp(-db) };
    case 270:
      return { x: clamp(-db), y: clamp(dg) };
    default:
      return { x: clamp(dg), y: clamp(db) };
  }
}

/** The resting pose moved a little toward the current one. */
export function settle(rest: Pose, pose: Pose): Pose {
  return {
    beta: rest.beta + (pose.beta - rest.beta) * TILT_SETTLE,
    gamma: rest.gamma + (pose.gamma - rest.gamma) * TILT_SETTLE,
  };
}
