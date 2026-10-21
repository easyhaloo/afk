import { describe, expect, it } from 'vitest';
import {
  BACKLOG_CHANGE_REQUEST_STATES,
  type BacklogChangeRequest,
} from '../src/backlog/model.js';
import {
  TRACKER_ISSUE_STATES,
  type TrackedIssue,
  type TrackedMR,
} from '../src/tracker/types.js';

/**
 * A state the list gains is a state the types accept.
 *
 * These are compile-time assertions: the types are written from the
 * lists, not beside them. A type that spelled the states out by hand
 * stops accepting a state the list gains, and the build says so.
 */
const issueStates: TrackedIssue['state'][] = [...TRACKER_ISSUE_STATES];
const mergeRequestStates: TrackedMR['state'][] = [...TRACKER_ISSUE_STATES];
const changeRequestStates: BacklogChangeRequest['state'][] = [...BACKLOG_CHANGE_REQUEST_STATES];

describe('the tracker and backlog state vocabularies', () => {
  it('names the states a tracker can report an issue in', () => {
    expect([...TRACKER_ISSUE_STATES]).toEqual(['opened', 'closed', 'merged']);
  });

  it('gives the issue and the merge request the same states', () => {
    // The two used to spell the same three names in two different
    // orders, which is two answers to one question.
    expect(issueStates).toEqual(['opened', 'closed', 'merged']);
    expect(mergeRequestStates).toEqual(issueStates);
  });

  it('names the states a change request can be in', () => {
    expect([...BACKLOG_CHANGE_REQUEST_STATES]).toEqual(['open', 'merged', 'closed']);
  });

  it('gives the change request the same states', () => {
    expect(changeRequestStates).toEqual(['open', 'merged', 'closed']);
  });
});
