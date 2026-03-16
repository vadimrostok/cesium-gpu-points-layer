declare module 'stats.js' {
  class Stats {
    dom: HTMLElement;

    /**
     * Adds the specified panel (0: FPS, 1: MS, 2: MB, 3: custom).
     */
    showPanel(panel: number): void;

    /**
     * Marks the beginning of an update interval.
     */
    begin(): void;

    /**
     * Marks the end of an update interval and updates the default FPS panel.
     */
    end(): number;

    /**
     * Updates the monitor without a timing pair.
     */
    update(): void;
  }

  export default Stats;
}
