/**
 * Persistence, shared by the API and the workers.
 *
 * Lives in a package rather than inside apps/api because the dispatcher,
 * reconciler and sweeper all write deployment state too. An app importing
 * another app's internals would be the alternative, and that is how a "shared"
 * module quietly becomes something nobody dares change.
 */

export {
  documentClient,
  tableName,
  resetClient,
  isConditionalCheckFailure,
} from './table.js';

export {
  createDeployment,
  getDeploymentById,
  getDeploymentConsistent,
  listDeployments,
  transition,
  patchDeployment,
  claimDeployment,
  failDeployment,
  findOverdueDeployments,
  type CreateDeploymentInput,
  type ListDeploymentsResult,
  type TransitionInput,
  type TransitionResult,
} from './deployments.js';

export {
  createProject,
  getProjectById,
  getProjectForUser,
  listProjects,
  countProjects,
  setActiveDeployment,
} from './projects.js';

export {
  hashToken,
  getUser,
  getUserByGithubId,
  putUser,
  createSession,
  getSession,
  deleteSession,
  consumeDailyQuota,
  SESSION_TTL_SEC,
  type Session,
  type User,
} from './identity.js';
