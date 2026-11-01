// Window events between chat cards and the study assistant chrome. Cards stay free of panel props.

export const LEARNING_NAVIGATE_EVENT = 'dovun-learning-navigate';
export const LEARNING_FIGURE_EVENT = 'dovun-learning-figure';

/** Open a learning archive location (hash). The chat panel closes itself on phones. */
export function navigateLearning(hash: string) {
  window.dispatchEvent(new CustomEvent(LEARNING_NAVIGATE_EVENT, { detail: { hash } }));
}

/** Open the 学习主图 sheet, optionally with a knowledge point selected. */
export function showLearningFigure(mapId: string, nodeId?: string) {
  window.dispatchEvent(new CustomEvent(LEARNING_FIGURE_EVENT, { detail: { mapId, nodeId } }));
}
