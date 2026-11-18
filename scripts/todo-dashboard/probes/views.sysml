// Views, viewpoints and rendering. The four decision surfaces judge relations
// over feature values; a view definition or viewpoint is a rendering projection,
// so this probe is expected to file NO row — the GRAPH rows (coverage.py KNOWN)
// carry the rendering evidence. A view is `partial`, never `read`, for the
// decision column.
package Views {
    part def System {
        attribute mass : Real = 10.0;
    }

    view def SystemView;
    viewpoint def OpsViewpoint;

    view ops : SystemView;
    viewpoint ov : OpsViewpoint;
}
