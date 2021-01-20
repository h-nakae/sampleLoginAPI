//import AuthChannel from "./utils/auth-channel";
const AuthChannel = require('./utils/auth-channel');
const PhoenixUtils = require('./utils/phoenix-utils');
//import { connectToReticulum } from "./utils/phoenix-utils";
//import configs from "../../utils/configs";

var express = require('express');
var router = express.Router();

/* GET users listing. */
router.get('/', function(req, res, next) {
  async email => {
    const authChannel = new AuthChannel(store);
    const socket = await PhoenixUtils.connectToReticulum();
    authChannel.setSocket(socket);
    const { authComplete } = await authChannel.startAuthentication(email);
    await authComplete;
    await checkIsAdmin(socket, store);
  }

  res.send('nyaaaaa');
});

module.exports = router;
