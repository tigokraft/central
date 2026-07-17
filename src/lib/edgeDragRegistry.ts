// Registry of each rendered edge's SVG path elements, keyed by edge id. Lets an in-progress
// node drag (see nodeDragController) update just the cables touching the moved node(s)
// directly via setAttribute("d", ...), without waiting for SVGEdgeLayer to re-render off a
// store change.

export interface EdgePathEls {
  hit: SVGPathElement | null;
  shadow: SVGPathElement | null;
  cable: SVGPathElement | null;
}

class EdgeDragRegistry {
  private els = new Map<string, EdgePathEls>();

  register(edgeId: string, refs: EdgePathEls) {
    this.els.set(edgeId, refs);
  }

  unregister(edgeId: string) {
    this.els.delete(edgeId);
  }

  setPath(edgeId: string, d: string) {
    const refs = this.els.get(edgeId);
    if (!refs) return;
    refs.hit?.setAttribute("d", d);
    refs.shadow?.setAttribute("d", d);
    refs.cable?.setAttribute("d", d);
  }
}

export const edgeDragRegistry = new EdgeDragRegistry();
