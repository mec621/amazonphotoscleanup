// Eye-openness and smile from MediaPipe Face Landmarker blendshapes.
// Loaded lazily by the feature worker. The wasm runtime is served from the
// extension; the model file is fetched once from Google's model bucket.

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import type { FaceStats } from '../shared/types';

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let ready: Promise<FaceLandmarker> | null = null;

function init(extensionBase: string): Promise<FaceLandmarker> {
  ready ??= (async () => {
    // useModule=true: classic importScripts loading doesn't work in a module worker.
    const fileset = await FilesetResolver.forVisionTasks(`${extensionBase}mediapipe`, true);
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 6,
      outputFaceBlendshapes: true,
    });
  })();
  ready.catch(() => (ready = null));
  return ready;
}

/** null when no face is found. */
export async function faceStats(extensionBase: string, image: ImageBitmap | OffscreenCanvas): Promise<FaceStats | null> {
  const lm = await init(extensionBase);
  const res = lm.detect(image as ImageBitmap);
  const shapes = res.faceBlendshapes ?? [];
  if (!shapes.length) return null;
  let eyes = 0;
  let smile = 0;
  for (const face of shapes) {
    const s = (name: string) => face.categories.find((c) => c.categoryName === name)?.score ?? 0;
    eyes += 1 - Math.max(s('eyeBlinkLeft'), s('eyeBlinkRight'));
    smile += (s('mouthSmileLeft') + s('mouthSmileRight')) / 2;
  }
  return { count: shapes.length, eyesOpen: eyes / shapes.length, smile: smile / shapes.length };
}
