<script lang="ts">
  import { AXIS_STEPS } from "../store";
  import type { Bounds } from "../geometry/client";

  /**
   * Moving the slice plane along the sweep.
   *
   * Two controls write the same value: a range for scrubbing (drag, arrow
   * keys, Home/End, Page Up/Down all come free with the native element) and a
   * number field for typing an exact position. Neither is a substitute for the
   * other -- scrubbing is how you explore a model, typing is how you go back
   * to the plane you were looking at yesterday.
   *
   * Both are expressed as DISTANCE FROM THE START OF THE SWEEP, not as a world
   * coordinate. The store's label makes the same choice for the same reason:
   * after a user rotation the sweep axis corresponds to nothing they could
   * cross-check in a slicer, and Front and Side are sign-flipping besides, so
   * a coordinate here would be a plausible-looking number that quietly lies.
   * The conversion back to the store's world-Z position happens on the way in.
   */
  interface Props {
    bounds: Bounds | null;
    /** The slice plane in the store's terms: a position along world Z. */
    axisPos: number;
    /** The store's `axisLabel`, e.g. "12.4 of 40.0 mm". */
    label: string;
    disabled: boolean;
    /** Called with a world-Z position, the same units `axisPos` is in. */
    onpos: (pos: number) => void;
  }

  let { bounds, axisPos, label, disabled, onpos }: Props = $props();

  const span = $derived(bounds ? bounds.max.z - bounds.min.z : 0);
  const offset = $derived(bounds ? axisPos - bounds.min.z : 0);
  /**
   * Matching the store's own increment keeps one arrow key press on the slider
   * and one press of the Dot Pad's panning key the same size of move. A model
   * with no thickness in this direction would give a step of zero, which the
   * browser rejects, so it falls back to something harmless.
   */
  const step = $derived(span > 0 ? span / AXIS_STEPS : 1);

  function commit(raw: string): void {
    const value = Number.parseFloat(raw);
    if (!bounds || !Number.isFinite(value)) return;
    // The store clamps to the extent, so an out-of-range typed value is
    // pinned to the near end rather than rejected.
    onpos(bounds.min.z + value);
  }
</script>

<fieldset {disabled}>
  <legend>Cross-section position</legend>

  <p id="scrub-help">
    Millimetres from the start of the sweep. The Dot Pad's panning keys move
    the same distance as one arrow key press here.
  </p>

  <p class="field">
    <label for="scrub-range">Position</label>
    <input
      id="scrub-range"
      type="range"
      min="0"
      max={span}
      {step}
      value={offset}
      aria-describedby="scrub-help"
      aria-valuetext={label}
      oninput={(e) => commit(e.currentTarget.value)}
    />
  </p>

  <p class="field">
    <label for="scrub-exact">Exact position, millimetres</label>
    <input
      id="scrub-exact"
      type="number"
      min="0"
      max={span}
      step="0.1"
      inputmode="decimal"
      aria-describedby="scrub-help"
      value={offset.toFixed(1)}
      onchange={(e) => commit(e.currentTarget.value)}
    />
  </p>

  <p>
    {#if label}
      <span>Now at {label}.</span>
    {:else}
      <span>No model loaded yet.</span>
    {/if}
  </p>
</fieldset>

<style>
  .field {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    margin: 0.5rem 0;
  }
  .field label {
    min-width: 14rem;
  }
  input[type="range"] {
    flex: 1 1 20rem;
  }
  input[type="number"] {
    width: 8rem;
  }
</style>
