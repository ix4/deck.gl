// Copyright (c) 2015 - 2017 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

import AggregationLayer from './aggregation-layer';
import GPUGridAggregator from './utils/gpu-grid-aggregation/gpu-grid-aggregator';
import {AGGREGATION_OPERATION} from './utils/aggregation-operation-utils';
import {Buffer} from '@luma.gl/core';
import {WebMercatorViewport, log} from '@deck.gl/core';
import GL from '@luma.gl/constants';
import {Matrix4} from 'math.gl';
import {getBoundingBox} from './utils/grid-aggregation-utils';
import {getValueFunc} from './utils/aggregation-operation-utils';
import BinSorter from './utils/bin-sorter';
import {pointToDensityGridDataCPU} from './cpu-grid-layer/grid-aggregator';

export default class GridAggregationLayer extends AggregationLayer {
  initializeState({aggregationProps, getCellSize}) {
    const {gl} = this.context;
    super.initializeState(aggregationProps);
    this.setState({
      // CPU aggregation results
      layerData: {},
      gpuGridAggregator: new GPUGridAggregator(gl, {id: `${this.id}-gpu-aggregator`}),
      cpuGridAggregator: pointToDensityGridDataCPU
    });
  }

  updateState(opts) {
    const {gpuAggregation} = opts.props;
    // will get new attributes
    super.updateState(opts);

    // update bounding box and cellSize
    this._updateGridState(opts);

    let aggregationDirty = false;
    const {needsReProjection} = this.state;
    const needsReAggregation = this._isAggregationDirty(opts);
    const vertexCount = this.getNumInstances();
    if (vertexCount <= 0) {
      return;
    }
    if (needsReProjection || (gpuAggregation && needsReAggregation)) {
      this._updateAccessors(opts);
      this._resetResults();
      this.getAggregatedData(opts);
      aggregationDirty = true;
    }
    if (!gpuAggregation && (aggregationDirty || needsReAggregation)) {
      // In case of CPU aggregation
      this._resetResults();
      this.updateWeightBins();
      this.uploadAggregationResults();
      aggregationDirty = true;
    }

    this.setState({aggregationDirty});
  }

  finalizeState() {
    super.finalizeState();
    const {gpuGridAggregator} = this.state;
    if (gpuGridAggregator) {
      gpuGridAggregator.delete();
    }
  }

  // Private

  _updateGridState(opts) {
    this._updateGridParams(opts);
    const {viewport} = this.context;
    const {dataChanged, cellSizeChanged, screenSpaceAggregation} = this.state;
    if (dataChanged && !screenSpaceAggregation) {
      const boundingBox = getBoundingBox(this.getAttributes(), this.getNumInstances());
      this.setState({boundingBox});
    }
    if (dataChanged || cellSizeChanged) {
      // for grid contour layers transform cellSize from meters to lng/lat offsets
      const gridOffset = this._getGridOffset();
      this.setState({gridOffset});

      let {width, height} = this.context.viewport;
      let gridTransformMatrix = new Matrix4();
      let cellOffset = [0, 0];
      let projectPoints = false;

      if (screenSpaceAggregation) {
        if (viewport instanceof WebMercatorViewport) {
          // project points from world space (lng/lat) to viewport (screen) space.
          projectPoints = true;
        } else {
          // Support Ortho viewport use cases.
          projectPoints = false;
          // Use pixelProjectionMatrix to transform points to viewport (screen) space.
          gridTransformMatrix = viewport.pixelProjectionMatrix;
        }
      } else {
        const {xMin, yMin, xMax, yMax} = this.state.boundingBox;
        width = xMax - xMin + gridOffset.xOffset;
        height = yMax - yMin + gridOffset.yOffset;

        // Setup transformation matrix so that every point is in +ve range
        gridTransformMatrix = gridTransformMatrix.translate([-1 * xMin, -1 * yMin, 0]);
        cellOffset = [-1 * xMin, -1 * yMin];
        projectPoints = false;
      }
      const numCol = Math.ceil(width / gridOffset.xOffset);
      const numRow = Math.ceil(height / gridOffset.yOffset);
      this._allocateResources(numRow, numCol);
      this.setState({gridTransformMatrix, projectPoints, width, height, cellOffset, numCol, numRow});
    }
  }

  getAggregatedData(opts) {
    const {gpuAggregation} = opts.props;
    const {
      cpuGridAggregator,
      gpuGridAggregator,
      cellSize,
      gridOffset,
      cellOffset,
      gridTransformMatrix,
      width,
      height,
      boundingBox,
      projectPoints
    } = this.state;
    const {props} = opts;
    const {viewport} = this.context;
    const attributes = this.getAttributes();
    // const projectPoints = false; // _TODO_ cleanup
    const vertexCount = this.getNumInstances();

    // TODO verify CPU aggregation path first.

    if (!gpuAggregation) {
      const result = cpuGridAggregator({
        data: props.data,
        cellSize,
        attributes,
        viewport,
        projectPoints,
        gridTransformMatrix,
        width,
        height,
        gridOffset,
        cellOffset,
        boundingBox
      });
      this.setState({
        layerData: result
      });
    } else {
      const {weights} = this.state;
      gpuGridAggregator.run({
        weights,
        cellSize: [gridOffset.xOffset, gridOffset.yOffset],
        width,
        height,
        gridTransformMatrix,
        useGPU: true, // _TODO_ delete this option in gpu aggregator
        vertexCount, // : vertexCount / 2,
        projectPoints,
        attributes,
        moduleSettings: this.getModuleSettings()
      });
    }
  }

  updateWeightBins() {
    const {getValue} = this.state;

    const sortedBins = new BinSorter(this.state.layerData.data || [], getValue, false);
    this.setState({sortedBins});
  }

  uploadAggregationResults() {
    const {numCol, numRow} = this.state;
    const {data} = this.state.layerData;
    const {sortedBins, minValue, maxValue, totalCount} = this.state.sortedBins;

    const ELEMENTCOUNT = 4;
    const aggregationSize = numCol * numRow * ELEMENTCOUNT;
    const aggregationData = new Float32Array(aggregationSize).fill(0);
    for (const bin of sortedBins) {
      const {lonIdx, latIdx} = data[bin.i];
      const {value, counts} = bin;
      // TODO this calculation need to be updated for ContourLaYER
      const cellIndex = (lonIdx + latIdx * numCol) * ELEMENTCOUNT;
      aggregationData[cellIndex] = value;
      aggregationData[cellIndex + ELEMENTCOUNT - 1] = counts;
    }
    const maxMinData = new Float32Array([maxValue, 0, 0, minValue]);
    const maxData = new Float32Array([maxValue, 0, 0, totalCount]);
    const minData = new Float32Array([minValue, 0, 0, totalCount]);
    // aggregationBuffer.setData({data: aggregationData});
    this._updateResults({aggregationData, maxMinData, maxData, minData});
  }

  // Private
  _allocateResources(numRow, numCol) {
    if (this.state.numRow !== numRow || this.state.numCol !== numCol) {
      const {count} = this.state.weights;
      const dataBytes = numCol * numRow * 4 * 4;
      if (count.aggregationBuffer) {
        count.aggregationBuffer.delete();
      }
      count.aggregationBuffer = new Buffer(this.context.gl, {
        byteLength: dataBytes,
        accessor: {
          size: 4,
          type: GL.FLOAT,
          divisor: 1
        }
      });
    }
  }

  _resetResults() {
    const {count} = this.state.weights;
    if (count) {
      count.aggregationData = null;
    }
  }

  _updateResults({aggregationData}) {
    const {count} = this.state.weights;
    if (count) {
      count.aggregationData = aggregationData;
    }
  }

  _updateAccessors(opts) {
    if (opts.props.gpuAggregation) {
      this._updateWeightParams(opts);
    } else {
      this._updateGetValueFuncs(opts);
    }
  }

  _updateWeightParams(opts) {
    const {
      getWeight,
      aggregation
    } = opts.props;
    const {count} = this.state.weights;
    count.getWeight = getWeight;
    count.aggregation = AGGREGATION_OPERATION[aggregation];
  }

  _updateGetValueFuncs({oldProps, props, changeFlags}) {
    const {getValue} = this.state;
    if (
      !getValue ||
      oldProps.aggregation !== props.aggregation ||
      (changeFlags.updateTriggersChanged &&
        (changeFlags.updateTriggersChanged.all || changeFlags.updateTriggersChanged.getWeight))
    ) {
      this.setState({getValue: getValueFunc(props.aggregation, props.getWeight)});
    }
  }

  _updateShaders(shaders) {
    this.state.gpuGridAggregator.updateShaders(shaders);
  }

  _getAggregationModel() {
    return this.state.gpuGridAggregator.gridAggregationModel;
  }

  _getGridOffset() {
    const cellSize = this.state.cellSize;
    return {xOffset: cellSize, yOffset: cellSize};
  }

  _updateGridParams(opts) {
    // Sublayers should implement this method.
    log.assert(false)();
  }
}

GridAggregationLayer.layerName = 'GridAggregationLayer';
