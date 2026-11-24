import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/api.js';
import { retryUnlessMissing } from './useTodo.js';

describe('retryUnlessMissing', () => {
  it('retries ordinary failures up to three times', () => {
    expect(retryUnlessMissing(0, new ApiError('服务暂不可用', undefined, 503))).toBe(true);
    expect(retryUnlessMissing(2, new Error('网络中断'))).toBe(true);
    expect(retryUnlessMissing(3, new Error('网络中断'))).toBe(false);
  });

  it('gives up at once when the task no longer exists', () => {
    expect(retryUnlessMissing(0, new ApiError('任务不存在', undefined, 404))).toBe(false);
  });
});
