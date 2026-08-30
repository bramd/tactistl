<script lang="ts">
  import type { Transport } from "../tactile/types";

  /**
   * Attaching a Dot Pad.
   *
   * One button per available transport, never a dropdown feeding a single
   * "Connect" button. Both Web Serial and Web Bluetooth open their device
   * picker only from a user gesture, and a click that first has to read a
   * select and then dispatch is still a gesture -- but a button whose label
   * says exactly which picker is about to open is also simply clearer, and it
   * is one keystroke rather than three.
   *
   * When nothing is available -- Firefox and Safari ship neither API -- the
   * absence is stated rather than left as a button that fails on click, and
   * every other part of the app keeps working against the on-screen preview.
   */
  interface Props {
    /** From the sink, USB first when both are present. */
    transports: Transport[];
    connected: boolean;
    /** Which transport the live connection uses; null when disconnected. */
    active: Transport | null;
    onconnect: (transport: Transport) => void;
    ondisconnect: () => void;
  }

  let { transports, connected, active, onconnect, ondisconnect }: Props =
    $props();

  const NAMES: Record<Transport, string> = {
    usb: "USB",
    ble: "Bluetooth",
  };
</script>

<section aria-labelledby="connection-heading">
  <h2 id="connection-heading">Tactile display</h2>

  {#if connected}
    <p>Connected to a Dot Pad over {active ? NAMES[active] : "an unknown link"}.</p>
    <button type="button" onclick={ondisconnect}>
      Disconnect from the Dot Pad over {active ? NAMES[active] : "this link"}
    </button>
  {:else if transports.length > 0}
    <p id="connect-help">
      Choosing a link opens your browser's device picker. Dismissing that
      picker is not an error; nothing changes and you can try again.
    </p>
    <p class="buttons">
      {#each transports as transport (transport)}
        <button
          type="button"
          aria-describedby="connect-help"
          onclick={() => onconnect(transport)}
        >
          Connect over {NAMES[transport]}
        </button>
      {/each}
    </p>
  {:else}
    <p>
      This browser cannot reach a Dot Pad: it offers neither Web Serial nor Web
      Bluetooth. Chrome or Edge on desktop offer both. Everything else on this
      page still works, and the preview below shows exactly what a connected
      display would be showing.
    </p>
  {/if}
</section>

<style>
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
