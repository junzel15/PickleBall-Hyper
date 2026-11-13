// Humanoid skeleton in the bind T-pose.
// Units: metres. +Y up, character faces +Z, character's LEFT is +X (glTF convention).
// Every bone's rest rotation is identity, so local axes line up with the world in the T-pose.

export const BONES = [];
function bone(name, parent, pos) {
  BONES.push({ name, parent: parent == null ? -1 : BONES.findIndex(b => b.name === parent), pos });
}

bone('Root', null, [0, 0, 0]);
bone('Hips', 'Root', [0, 0.98, 0]);
bone('Spine', 'Hips', [0, 1.07, -0.005]);
bone('Spine1', 'Spine', [0, 1.18, -0.012]);
bone('Spine2', 'Spine1', [0, 1.30, -0.015]);
bone('Neck', 'Spine2', [0, 1.485, -0.02]);
bone('Head', 'Neck', [0, 1.60, -0.005]);
for (const [side, s] of [['Left', 1], ['Right', -1]]) {
  bone(`${side}Shoulder`, 'Spine2', [s * 0.025, 1.43, -0.015]);
  bone(`${side}Arm`, `${side}Shoulder`, [s * 0.17, 1.44, -0.02]);
  bone(`${side}ForeArm`, `${side}Arm`, [s * 0.455, 1.44, -0.02]);
  bone(`${side}ForeArmTwist`, `${side}ForeArm`, [s * 0.585, 1.44, -0.02]);
  bone(`${side}Hand`, `${side}ForeArmTwist`, [s * 0.715, 1.44, -0.02]);
}
// Grip point inside the right fist; the paddle hangs off this bone (attach props here too)
export const GRIP = [-0.80, 1.413, -0.02];
bone('Paddle', 'RightHand', GRIP);
for (const [side, s] of [['Left', 1], ['Right', -1]]) {
  bone(`${side}UpLeg`, 'Hips', [s * 0.095, 0.93, 0]);
  bone(`${side}Leg`, `${side}UpLeg`, [s * 0.095, 0.505, 0.005]);
  bone(`${side}Foot`, `${side}Leg`, [s * 0.095, 0.085, -0.01]);
  bone(`${side}ToeBase`, `${side}Foot`, [s * 0.095, 0.022, 0.115]);
}

export const B = Object.fromEntries(BONES.map((b, i) => [b.name, i]));
export const restLocal = BONES.map(b => (b.parent < 0 ? [...b.pos] : b.pos.map((v, k) => v - BONES[b.parent].pos[k])));
