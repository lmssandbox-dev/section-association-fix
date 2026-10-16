'use strict';

// Call only with the token validated by ltijs, never request body/query data.
function deploymentGuard(expectedId) {
  const allowedId = typeof expectedId === 'string' ? expectedId.trim() : '';
  return (token, req, res) => {
    if (!allowedId) {
      res.status(503).send('LTI setup incomplete: configure BS_DEPLOYMENT_ID and restart.');
      return false;
    }
    if (typeof token?.deploymentId !== 'string' || token.deploymentId !== allowedId) {
      res.status(403).send('LTI deployment not authorized.');
      return false;
    }
    return true;
  };
}

module.exports = { deploymentGuard };
