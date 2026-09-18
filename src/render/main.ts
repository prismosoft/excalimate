import '@excalidraw/excalidraw/index.css';
import { parseProjectDocument } from '@excalimate/project-schema';
import { fromProjectDocument } from '../core/models/Project';
import { extractTargets } from '../components/Canvas/extractTargets';
import { useProjectStore } from '../stores/projectStore';
import { useAnimationStore } from '../stores/animationStore';
import { exportAnimation } from '../services/ExportService';

export interface HeadlessRenderOptions {
  format: 'mp4' | 'webm';
  fps?: number;
  quality?: 'low' | 'medium' | 'high' | 'very-high';
  theme?: 'light' | 'dark';
}

async function render(
  projectInput: unknown,
  options: HeadlessRenderOptions,
): Promise<{ ok: true }> {
  const document = parseProjectDocument(projectInput);
  const project = fromProjectDocument(document);

  const projectStore = useProjectStore.getState();
  projectStore.loadProject(project);
  projectStore.setCameraFrame(document.playback.cameraFrame);
  projectStore.setTargets(extractTargets(project.scene.elements));
  // setTargets may auto-fit a default-looking frame. The canonical project
  // frame always wins for deterministic server-side rendering.
  projectStore.setCameraFrame(document.playback.cameraFrame);

  const animationStore = useAnimationStore.getState();
  animationStore.setTimeline(document.timeline);
  animationStore.setClipRange(
    document.playback.clipStart,
    document.playback.clipEnd,
  );

  await exportAnimation({
    format: options.format,
    fps: options.fps ?? document.timeline.fps,
    quality: options.quality ?? 'high',
    theme: options.theme ?? 'light',
  });

  return { ok: true };
}

declare global {
  interface Window {
    excalimateRenderer: {
      render: typeof render;
    };
  }
}

window.excalimateRenderer = { render };
