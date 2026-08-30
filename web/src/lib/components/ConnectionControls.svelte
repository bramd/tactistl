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

  /**
   * Keeping focus across the button swap.
   *
   * Activating "Connect over USB" removes that very button from the DOM the
   * moment `connected` flips, so focus falls to <body> and the next Tab
   * restarts at the top of the page -- with nothing to indicate why. The same
   * happens on disconnect, and again on an unplug, which the user did not
   * cause at all.
   *
   * So the button that REPLACES the one that went away is focused, but only
   * when the swap actually took the focus: an unplug while the user is
   * standing on the scrubber must not yank them over here. `document.body`
   * counts as "took it", because that is where focus has already landed by the
   * time the effect runs, and it is also where a device picker leaves it.
   */
  let sectionEl: HTMLElement | undefined = $state();
  let disconnectButton: HTMLButtonElement | undefined = $state();
  let connectButtons: HTMLButtonElement[] = $state([]);

  let hadFocus = false;
  let settled = false;

  $effect.pre(() => {
    // Read so this re-runs on the swap, and read BEFORE the DOM updates --
    // afterwards the element that had focus no longer exists.
    void connected;
    const el = document.activeElement;
    hadFocus = el === null || el === document.body || !!sectionEl?.contains(el);
  });

  $effect(() => {
    void connected;
    // Never on first render: nothing was swapped out, and stealing focus on
    // load would drop the user into the middle of the page.
    if (!settled) {
      settled = true;
      return;
    }
    if (!hadFocus) return;
    (connected ? disconnectButton : connectButtons[0])?.focus();
  });
</script>

<section bind:this={sectionEl} aria-labelledby="connection-heading">
  <h2 id="connection-heading">Tactile display</h2>

  {#if connected}
    <p>Connected to a Dot Pad over {active ? NAMES[active] : "an unknown link"}.</p>
    <button type="button" bind:this={disconnectButton} onclick={ondisconnect}>
      Disconnect from the Dot Pad over {active ? NAMES[active] : "this link"}
    </button>
  {:else if transports.length > 0}
    <p id="connect-help">
      Choosing a link opens your browser's device picker. Dismissing that
      picker is not an error; nothing changes and you can try again.
    </p>
    <p class="buttons">
      {#each transports as transport, i (transport)}
        <button
          type="button"
          bind:this={connectButtons[i]}
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
