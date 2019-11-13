// Copyright (c) 2015 - 2019 Uber Technologies, Inc.
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

import CPUAggregator from '../utils/cpu-aggregator';
// TODO move this file to utils
import {pointToDensityGridDataCPU} from './../cpu-grid-layer/grid-aggregator';

// these default dimensions serve ContourLayer and ScreenGridLayer
const DIMENSIONS = [
  {
    key: 'fillColor',
    accessor: 'getFillColor',
    pickingInfo: 'colorValue',
    getBins: {
      sort: false,
      triggers: {
        value: {
          prop: 'getValue',
          updateTrigger: 'getValue'
        },
        weight: {
          prop: 'getWeight',
          updateTrigger: 'getWeight'
        },
        aggregation: {
          prop: 'aggregation'
        }
      }
    },
  }
];

export default class CPUGridAggregator extends CPUAggregator{
  constructor(opts) {
    // customize dimensions
    super({
      dimensions: DIMENSIONS,
      getAggregator: props => pointToDensityGridDataCPU,
      getCellSize: opts.getCellSize
    });
  }

  updateState(opts) {
    // Aggregate data in into bins
    super.updateState(opts);

    const {gridHash, gridOffset, data} = this.state.layerData;
    const {sortedBins, minValue, maxValue, totalCount} = this.state.dimensions.fillColor.sortedBins;
    // const {width, height} = this.state;
    if(this.state.aggregationDirty) {
      const {viewport} = opts;
      const width = opts.width || viewport.width;
      const height = opts.height || viewport.height;
      const numCol = Math.ceil(width / gridOffset.xOffset);
      const numRow = Math.ceil(height / gridOffset.yOffset);

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
      this.setState({aggregationData, maxMinData, maxData, minData});
    }
  }
  run(opts) {
    console.log('In run method');
    const {aggregationData, maxData} = this.state;
    if (opts.weights.color) {
      const {aggregationBuffer, maxTexture} = opts.weights.color;
      opts.weights.color.aggregationData = aggregationData;
      aggregationBuffer.setData({data: aggregationData});
      maxTexture.setImageData({data: maxData});
    }
    if (opts.weights.count) {
      const {aggregationBuffer} = opts.weights.count;
      opts.weights.count.aggregationData = aggregationData;
      aggregationBuffer.setData({data: aggregationData});
    }
  }

  updateGridSize(opts) {
    const {moduleSettings, cellSize} = opts;
    const {viewport} = moduleSettings;
    const width = opts.width || viewport.width;
    const height = opts.height || viewport.height;
    const numCol = Math.ceil(width / cellSize[0]);
    const numRow = Math.ceil(height / cellSize[1]);
    this.setState({numCol, numRow, windowSize: [width, height]});
  }

}
