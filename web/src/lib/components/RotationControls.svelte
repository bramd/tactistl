<script lang="ts">
  /**
   * The three rotation fields.
   *
   * They fire on `change`, not on `input`: each committed value costs a bounds
   * request to the geometry worker, and typing "90" through an `input`
   * handler would ask for the bounds at 9 degrees on the way past. `change`
   * fires on blur and on Enter, which is exactly "the user means this number".
   */
  interface Props {
    rotation: { x: number; y: number; z: number };
    disabled: boolean;
    onrotate: (axis: "x" | "y" | "z", degrees: number) => void;
  }

  let { rotation, disabled, onrotate }: Props = $props();

  const AXES = [
    { axis: "x", id: "rot-x", label: "X rotation, degrees" },
    { axis: "y", id: "rot-y", label: "Y rotation, degrees" },
    { axis: "z", id: "rot-z", label: "Z rotation, degrees" },
  ] as const;

  function commit(axis: "x" | "y" | "z", raw: string): void {
    const degrees = Number.parseFloat(raw);
    // A half-typed or emptied field is left alone rather than snapped to zero:
    // silently rotating the model back to square because a field was briefly
    // empty is the kind of thing you cannot see happen.
    if (!Number.isFinite(degrees)) return;
    onrotate(axis, degrees);
  }
</script>

<fieldset {disabled}>
  <legend>Rotation</legend>

  <p id="rotation-help">
    Degrees about the world X, Y and Z axes. The rotations are applied in that
    order &mdash; X first, then Y, then Z &mdash; which is the same convention
    your slicer uses, so a value that orients the model here orients it there.
  </p>

  {#each AXES as a (a.id)}
    <p class="field">
      <label for={a.id}>{a.label}</label>
      <input
        id={a.id}
        type="number"
        step="1"
        inputmode="decimal"
        aria-describedby="rotation-help"
        value={rotation[a.axis]}
        onchange={(e) => commit(a.axis, e.currentTarget.value)}
      />
    </p>
  {/each}
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
    min-width: 14rem;
  }
  input {
    width: 8rem;
  }
</style>
