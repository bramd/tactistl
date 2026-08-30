<script lang="ts">
  /**
   * Choosing an STL.
   *
   * The file input is the whole feature; drag-and-drop is an addition layered
   * on top of it and never a replacement. Everything here is reachable and
   * operable from the keyboard alone, because the person this app exists for
   * does not use a mouse.
   *
   * The drop handlers live on `<svelte:window>` rather than on a styled
   * drop-zone div. Dropping anywhere on the page works, an accidental drop can
   * never navigate the browser away from the app, and there is no static
   * element pretending to be interactive for a screen reader to trip over.
   */
  interface Props {
    /**
     * True while a load is in flight, so a drop landing mid-parse is ignored.
     *
     * It deliberately does NOT disable the file input. Disabling the element
     * the user is standing on drops focus to <body>, and a large STL takes
     * seconds -- so the most repeated interaction in the app would throw the
     * user back to the top of the page on every use. The parent guards
     * re-entrancy on its own state instead.
     */
    busy: boolean;
    /** Handed the chosen file. The parent owns the parse and all error reporting. */
    onfile: (file: File) => void;
  }

  let { busy, onfile }: Props = $props();

  function first(list: FileList | null | undefined): File | null {
    return list && list.length > 0 ? list[0] : null;
  }
</script>

<svelte:window
  ondragover={(e) => {
    // Without preventDefault on dragover the drop event never fires at all.
    e.preventDefault();
  }}
  ondrop={(e) => {
    // And without it here the browser navigates to the dropped file, throwing
    // away the whole session.
    e.preventDefault();
    if (busy) return;
    const file = first(e.dataTransfer?.files);
    if (file) onfile(file);
  }}
/>

<section aria-labelledby="model-heading">
  <h2 id="model-heading">Model</h2>

  <p id="model-help">
    Choose an STL file. Binary and ASCII STL are both understood. You can also
    drag a file from your file manager and drop it anywhere on this page.
  </p>

  <p class="field">
    <label for="model-file">STL file</label>
    <input
      id="model-file"
      type="file"
      accept=".stl,model/stl,application/sla"
      aria-describedby="model-help"
      onchange={(e) => {
        const input = e.currentTarget;
        const file = first(input.files);
        // Cleared so that picking the SAME path again still fires a change
        // event -- otherwise re-loading a file you have just edited in your
        // CAD tool silently does nothing.
        input.value = "";
        if (file) onfile(file);
      }}
    />
  </p>
</section>

<style>
  .field {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: baseline;
  }
</style>
