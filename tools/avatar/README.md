# Procedural pickleball player (GLB)

Everything is generated from code: no FBX, scans or third-party assets.

```
node tools/avatar/build.mjs     # -> assets/3d/pickleball_player.glb + pickleball_player_viewer.html
node tools/avatar/preview.mjs [outDir] [Forehand,Serve,closeup,...]   # PNG contact sheets (software renderer)
```

Open `assets/3d/pickleball_player_viewer.html` in a browser to orbit the model and play each clip.

## Model
- Adult male, 1.78 m tall, metres, +Y up, faces +Z (glTF convention). The bind pose is a T-pose.
- About 17k vertices, 34k triangles, 15 PBR materials (no textures). Right-handed player with the paddle in the right hand.
- 26 bones with Mixamo-style names, so Unity Humanoid / Blender auto-mapping works:
  `Root, Hips, Spine, Spine1, Spine2, Neck, Head, {Left,Right}{Shoulder,Arm,ForeArm,ForeArmTwist,Hand}, Paddle, {Left,Right}{UpLeg,Leg,Foot,ToeBase}`.
- `Paddle` is a child of `RightHand` at the grip, which makes it a ready-made attach point for the ball or for swapping paddles.

## Clips
| Clip | Length | Loop | Notes |
|---|---|---|---|
| TPose | 1 frame | | bind pose |
| Idle | 4.0 s | yes | relaxed, weight shift, breathing, paddle at side |
| Ready | 2.0 s | yes | knees bent, paddle chest-high, small split-step bounce |
| Forehand | 1.2 s | | unit turn, step in, contact ≈ 0.50 s, follow-through, back to Ready |
| Backhand | 1.2 s | | one-handed, contact ≈ 0.50 s |
| Serve | 1.6 s | | underhand, ball drop ≈ 0.72 s, contact below the waist ≈ 0.85 s |
| Smash | 1.4 s | | trophy position, contact at full reach ≈ 0.58 s |
| Run | 0.7 s | yes | in place |
| StrafeLeft / StrafeRight | 0.8 s | yes | side shuffle in place |

All clips are in place (the only translation is the Hips bob). The one-shot strokes start and end in the Ready pose, so they blend straight into it.

## Editing
- `lib/body.mjs`: body shape (cross-section tables), face, clothing colours (`MATERIALS`).
- `lib/anim.mjs`: poses are described as foot placement, hip/chest turn, hand positions and paddle direction. IK solves the limbs. Edit the key poses and rebuild.
- `lib/rig.mjs`: skeleton. `lib/gltf.mjs`: GLB writer.
