import { QueryList } from '@angular/core';
import { handleLoaded } from './layout-handlers';

describe('layout-handlers', () => {
  it('does not initialize the viewport before node elements exist', () => {
    const resetScaleAndCenter = jasmine.createSpy('resetScaleAndCenter');
    const emitCanvasChangeEvent = jasmine.createSpy('emitCanvasChangeEvent');
    const flow = {
      fCanvas: () => ({ resetScaleAndCenter, emitCanvasChangeEvent }),
      useAutoLayout: true,
      viewportInitialized: false,
      nodes: () => [{ id: 'n1' }],
      nodeEls: new QueryList(),
    } as any;

    handleLoaded(flow);

    expect(flow.viewportInitialized).toBeFalse();
    expect(resetScaleAndCenter).not.toHaveBeenCalled();
    expect(emitCanvasChangeEvent).toHaveBeenCalled();
  });

  it('initializes the viewport once node elements are mounted', () => {
    const resetScaleAndCenter = jasmine.createSpy('resetScaleAndCenter');
    const emitCanvasChangeEvent = jasmine.createSpy('emitCanvasChangeEvent');
    const nodeEls = new QueryList();
    nodeEls.reset([{} as never]);

    const flow = {
      fCanvas: () => ({ resetScaleAndCenter, emitCanvasChangeEvent }),
      useAutoLayout: true,
      viewportInitialized: false,
      nodes: () => [{ id: 'n1' }],
      nodeEls,
    } as any;

    handleLoaded(flow);

    expect(flow.viewportInitialized).toBeTrue();
    expect(resetScaleAndCenter).toHaveBeenCalledOnceWith(false);
    expect(emitCanvasChangeEvent).toHaveBeenCalled();
  });
});
