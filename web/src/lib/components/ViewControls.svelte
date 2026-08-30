<script lang="ts">
  import { ViewAxis, type ViewAxisValue } from "../store";

  /**
   * Which way the cross-section is taken, and how it is drawn.
   *
   * Back and Left are deliberately absent as view options. The cross-section
   * through a model from the front and from the back is the same set of
   * points; only the direction you look at it from differs, and that is what
   * "mirror" is. Offering six views where three views and a mirror describe
   * everything would mean two spellings of every plane.
   */
  interface Props {
    view: ViewAxisValue;
    mirror: boolean;
    filled: boolean;
    disabled: boolean;
    onview: (view: ViewAxisValue) => void;
    onmirror: (mirror: boolean) => void;
    onfilled: (filled: boolean) => void;
  }

  let { view, mirror, filled, disabled, onview, onmirror, onfilled }: Props =
    $props();

  const VIEWS = [
    { value: ViewAxis.Top, label: "Top — sweep down through the model" },
    { value: ViewAxis.Front, label: "Front — sweep back through the model" },
    { value: ViewAxis.Side, label: "Side — sweep across the model" },
  ];

  /** The select's values are strings on the wire; the store wants the enum. */
  function toViewAxis(raw: string): ViewAxisValue {
    const n = Number.parseInt(raw, 10);
    return (n === ViewAxis.Front ? ViewAxis.Front
      : n === ViewAxis.Side ? ViewAxis.Side
      : ViewAxis.Top);
  }
</script>

<fieldset {disabled}>
  <legend>View</legend>

  <p class="field">
    <label for="view-axis">Cross-section direction</label>
    <select
      id="view-axis"
      aria-describedby="view-help"
      value={String(view)}
      onchange={(e) => onview(toViewAxis(e.currentTarget.value))}
    >
      {#each VIEWS as v (v.value)}
        <option value={String(v.value)}>{v.label}</option>
      {/each}
    </select>
  </p>

  <p id="view-help">
    Choosing a direction re-centres the cross-section in the new sweep, because
    a position measured along one direction means nothing along another.
  </p>

  <p class="field">
    <input
      id="view-mirror"
      type="checkbox"
      checked={mirror}
      onchange={(e) => onmirror(e.currentTarget.checked)}
    />
    <label for="view-mirror">
      Mirror &mdash; view from the opposite side. This is how Back and Left are
      offered: the cross-section is identical, only the viewing direction is
      reversed.
    </label>
  </p>

  <p class="field">
    <input
      id="view-filled"
      type="checkbox"
      checked={filled}
      onchange={(e) => onfilled(e.currentTarget.checked)}
    />
    <label for="view-filled">
      Filled &mdash; fill the cross-section. With this off you feel the outline
      only.
    </label>
  </p>
</fieldset>

<style>
  .field {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: baseline;
    margin: 0.5rem 0;
  }
  .field label {
    max-width: 46rem;
  }
</style>
