// Registry of each node's wrapper DOM element, keyed by node id. Lets an in-progress node
// drag (owned by a single CanvasNodeWrapper instance, see nodeDragController) reach into
// sibling nodes' elements too — e.g. a multi-select drag or a container carrying its
// children along — and move them directly, without going through zustand until the gesture
// ends. Mirrors the registration idiom viewportController uses for the pan/zoom transform.

class NodeDragRegistry {
  private els = new Map<string, HTMLDivElement>();

  register(id: string, el: HTMLDivElement) {
    this.els.set(id, el);
  }

  unregister(id: string) {
    this.els.delete(id);
  }

  get(id: string): HTMLDivElement | undefined {
    return this.els.get(id);
  }
}

export const nodeDragRegistry = new NodeDragRegistry();
