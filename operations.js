var fs = require("fs");
var ObjectId = M.mongo.ObjectID;

/*
 *  getUploadPermissions operation
 *
 *  This returns the user permisions to see and use the uploaders for a specific template
 *
 * */
exports.getUploadPermissions = function (link) {

    if (!link.data || !link.data.template) {
        return link.send(400);
    }

    // get template from crud
    M.emit("crud.read", {
        templateId: "000000000000000000000000",
        role: link.session.crudRole,
        query: {
            _id: ObjectId(link.data.template._id)
        },
        noCursor: true
    }, function (err, template) {

        if (err) {
            return link.send(500, err);
        }
        if (!template[0]) {
            return link.send(404, "Template not found");
        }
        template = template[0];

        // check if uploader configuration is correct
        if (!template.options || !template.options.uploader || !template.options.uploader.uploaders) {
            return link.send(200, {});
        }
        if (!Object.keys(template.options.uploader.uploaders).length) {
            return link.send(200, {});
        }

        var permissions = {};
        for (var key in template.options.uploader.uploaders) {
            if (!template.options.uploader.uploaders[key].access || template.options.uploader.uploaders[key].access.indexOf("u") === -1) {
                permissions[key] = false;
            } else {
                permissions[key] = true;
            }
        }

        link.send(200, permissions);
    });
}

/*
 *  upload operation
 *
 *  This handle the uploaded file data (generated by the Mono core) and
 *  sends it on the client side
 *
 * */
exports.upload = function (link) {

    // this is necessary because IE does not properly interpret
    // application/json content types in an IFRAME
    link.res.headers["content-type"] = "text/plain";

    // validate upload
    if (!link.files || !link.files.file || !link.files.file.size) {
        return link.send(400, { error: "Invalid upload" });
    }

    // verify if uploadDir exists
    if (!link.params || !link.params.uploadDir || !link.params.dsUpload) {
        return link.send(400, { error: "Missing params: uploadDir or dsUpload." });
    }

    // if a template id was provided handle this as a template upload
    if (link.data && link.data.templateId) {
        handleTemplateUpload(link);
    } else {
        // if no template id provide handle this as a normal upload
        handleDefaultUpload(link);
    }
};

function handleTemplateUpload (link) {

    // get the uploaded file path
    var uploadedFilePath = M.app.getPath() + "/" + link.files.file.path;

    if (!link.data || !link.data.uploader) {
        cleanUploadDirOnError(uploadedFilePath);
        return link.send(400, "Uploader key missing");
    }

    // get template from crud
    M.emit("crud.read", {
        templateId: "000000000000000000000000",
        role: link.session.crudRole,
        query: {
            _id: ObjectId(link.data.templateId)
        },
        noCursor: true
    }, function (err, template) {

        if (err) {
            cleanUploadDirOnError(uploadedFilePath);
            return link.send(500, { error: err });
        }
        if (!template[0]) {
            cleanUploadDirOnError(uploadedFilePath);
            return link.send(404, { error: "Template not found" });
        }
        template = template[0];

        // check permissions
        if (!template.options || !template.options.uploader || !template.options.uploader.uploaders) {
            cleanUploadDirOnError(uploadedFilePath);
            return link.send(400, { error: "Bad uploader template configuration" });
        }
        if (!Object.keys(template.options.uploader.uploaders).length) {
            cleanUploadDirOnError(uploadedFilePath);
            return link.send(400, { error: "Bad uploader template configuration" });
        }

        var uploaderConfig = template.options.uploader.uploaders[link.data.uploader];
        if (!uploaderConfig || uploaderConfig.access.indexOf("u") === -1) {
            cleanUploadDirOnError(uploadedFilePath);
            return link.send(403, { error: "Permission denied" });
        }

        // accept types default value
        var acceptTypes = uploaderConfig.acceptTypes || [];

        // get the extension of the uploaded file
        var fileExt = link.files.file.name;
        fileExt = fileExt.substring(fileExt.lastIndexOf(".")) || "";

        // check the file type
        if (acceptTypes.length && !checkFileType(fileExt, acceptTypes)) {
            cleanUploadDirOnError(uploadedFilePath);

            // return bad request
            return link.send(400, { error: "Invalid file extension." });
        }

        uploaderConfig.uploadDir = link.params.uploadDir + (uploaderConfig.uploadDir || "");
        // get the absolute and relative path to the upload directory
        getUploadDir({
            uploadDir: uploaderConfig.uploadDir,
            customUpload: uploaderConfig.customUpload,
            data: link.data,
            link: link
        }, function (err, uploadDir, relativeUploadDir) {

            if (err) {
                cleanUploadDirOnError(uploadedFilePath);
                return link.send(400, { error: err });
            }

            // finish the upload
            finishUpload({
                uploadDir: uploadDir,
                relativeUploadDir: relativeUploadDir,
                link: link,
                uploadFileEvent: uploaderConfig.uploadFileEvent,
                fileExt: fileExt,
                uploadedFilePath: uploadedFilePath,
                template: true
            }, function (err, args) {

                if (err) {
                    cleanUploadDirOnError(uploadedFilePath);
                    return link.send(err.status, err.error);
                }

                // done
                link.send(200, { success: args });
            });
        });
    });
}

function handleDefaultUpload (link) {

    // accept types default value
    link.params.acceptTypes = link.params.acceptTypes || [];

    // get the uploaded file path
    var uploadedFilePath = M.app.getPath() + "/" + link.files.file.path;

    // get the extension of the uploaded file
    var fileExt = link.files.file.name;
    fileExt = fileExt.substring(fileExt.lastIndexOf(".")) || "";

    // check the file type
    if (link.params.acceptTypes.length && !checkFileType(fileExt, link.params.acceptTypes)) {

        // return bad request
        cleanUploadDirOnError(uploadedFilePath);
        return link.send(400, { error: "Invalid file extension." });
    }

    // get the absolute and relative path to the upload directory
    getUploadDir({
        uploadDir: link.params.uploadDir,
        customUpload: link.params.customUpload,
        data: link.data,
        link: link
    }, function (err, uploadDir, relativeUploadDir) {

        if (err) {
            cleanUploadDirOnError(uploadedFilePath);
            return link.send(400, { error: err });
        }

        // finish the upload
        finishUpload({
            uploadDir: uploadDir,
            relativeUploadDir: relativeUploadDir,
            link: link,
            uploadFileEvent: link.params.uploadFileEvent,
            fileExt: fileExt,
            uploadedFilePath: uploadedFilePath
        }, function (err, args) {

            if (err) {
                cleanUploadDirOnError(uploadedFilePath);
                return link.send(err.status, err.error);
            }

            // done
            link.send(200, { success: args });
        });
    });
}

/*
 *  This function completes the file upload for both upload methods
 *
 *  Arguments
 *    @options: object containing:
 *      - uploadDir
 *      - realtiveUploadDir
 *      - link
 *      - uploadFileEvent
 *      - fileExt
 *      - uploadedFilePath
 *      - template (true/false)
 *    @callback: the callback function
 * */
function finishUpload (options, callback) {

    // build required information
    var generatedId = options.uploadedFilePath.substring(options.uploadedFilePath.lastIndexOf("/") + 1);
    var newFilePath = options.uploadDir + "/" + generatedId + options.fileExt;

    // get the collection from datasource
    getCollection(options.link.params.dsUpload, function (err, collection) {

        // handle error
        if (err) { return callback({ status: 500, error: collection }); }

        // create doc to insert object
        var docToInsert = {
            fileName: options.link.files.file.name,
            extension: options.fileExt,
            absoluteFilePath: newFilePath,
            filePath: options.relativeUploadDir + "/" + generatedId + options.fileExt,
            id: generatedId
        };

        // add template id and uploader if this is a template upload
        if (options.template && options.link.data && options.link.data.templateId && options.link.data.uploader) {
            docToInsert.template = options.link.data.templateId;
            docToInsert.uploader = options.link.data.uploader;
        }

        /*
         *  getArgToSend ()
         *
         *  This returns the argument to send on the client side
         * */
        function getArgToSend (doc) {
            var arg;
            switch (options.link.params.emitArgument) {
                case "object":
                    arg = doc;
                    break;
                case "path":
                    arg = doc.filePath;
                    break;
                default:
                    var emitArg = options.link.params.emitArgument;
                    if (typeof emitArg === "object" && emitArg.type === "custom") {
                        arg = doc[emitArg.value];
                    } else {
                        arg = doc.id;
                    }
                    break;
            }

            return arg;
        }

        /*
         *  insertFileDataInDatabase (fileInfo)
         *
         *  This function inserts an object with the file information in the
         *  database
         * */
        function insertFileDataInDatabase (fileInfo) {

            // inser the file information
            collection.insert(fileInfo, function (err, doc) {

                // handle error
                if (err) { return callback({ status: 500, error: err }); }

                // inserted doc is the first one
                doc = doc[0];

                // and finally send the response
                return callback(null, getArgToSend(doc));
            });
        }

        // rename the file (this just adds the file extension)
        fs.rename(options.uploadedFilePath, newFilePath, function (err) {

            // handle error
            if (err) { return callback({ status: 500, error: err }); }

            // if upladFileEvent is provided
            if (options.uploadFileEvent) {

                // call for a custom handler
                M.emit(options.uploadFileEvent, {
                    docToInsert: docToInsert,
                    link: options.link
                }, function (err, newDocToInsert) {

                    // handle error
                    if (err) { return callback({ status: 500, error: err }); }

                    // if we don't send any new document, docToInsert will be inserted
                    newDocToInsert = newDocToInsert || docToInsert;

                    // insert the file data in the database
                    insertFileDataInDatabase(newDocToInsert);
                });
            // if it is not provided
            } else {
                // insert data directly
                insertFileDataInDatabase(docToInsert);
            }
        });
    });
}

// delete the uploaded file if an error occured or invalid file
function cleanUploadDirOnError (filePath) {
    fs.unlink(filePath, function (err) {
        if (err) { console.error(err); }
    });
}

/*
 *  getDocuments operation
 *
 *  This function returns the documents of a template uploader
 *
 * */
 exports.getDocuments = function (link) {

    if (!link.data || !link.data.template || !link.data.uploader) {
        return link.send(400, "BAD_REQUEST");
    }

    var template = link.data.template;
    var uploader = link.data.uploader;
    if (typeof link.data.template === "object") {
        template = template._id;
    }

    // fetch template
    M.emit("crud.read", {
        templateId: "000000000000000000000000",
        role: link.session.crudRole,
        query: {
            _id: ObjectId(template)
        },
        noCursor: true
    }, function (err, template) {

        if (err) {
            return link.send(500, err);
        }
        if (!template[0]) {
            return link.send(404, "Template not found");
        }
        template = template[0];

        // check permissions
        if (!template.options || !template.options.uploader || !template.options.uploader.uploaders) {
            return link.send(400, "Bad uploader template configuration");
        }
        if (!Object.keys(template.options.uploader.uploaders).length) {
            return link.send(400, "Bad uploader template configuration");
        }

        var uploaderConfig = template.options.uploader.uploaders[uploader];
        if (!uploaderConfig || uploaderConfig.access.indexOf("d") === -1) {
            return link.send(200, {});
        }

        // check the remove permissions
        if (!uploaderConfig || uploaderConfig.access.indexOf("r") === -1) {
            var removeForbidden = true;
        }

        // build fetch query
        var query = {
            template: template._id.toString(),
            uploader: uploader
        };
        link.data.query = link.data.query || {};
        for (var key in link.data.query) {
            query[key] = link.data.query[key];
        }
        link.data.options = link.data.options || {};

        // fetch documents
        getCollection(link.params.dsUpload, function (err, collection) {

            // handle error
            if (err) { return link.send(500, err); }

            collection.find(query, link.data.options).toArray(function (err, docs) {

                // handle error
                if (err) { return link.send(500, err); }

                link.send(200, { docs: docs, removeForbidden: removeForbidden || false });
            });
        });
    });
 }

/*
 *  download operation
 *
 *  This is the download operation which gets the id of a file and returns it
 *
 * */
exports.download = function (link) {

    if (!link.data && !link.query) {
        return;
    }

    // get the itemId
    var itemId, template, uploader;
    if (link.query.id) {
        itemId = link.query.id;
        template = link.query.template;
        uploader = link.query.uploader;
    } else if (link.data) {
        if (link.data.itemId) {
            itemId = link.data.itemId;
            template = link.data.template;
            uploader = link.data.uploader;
        } else {
            return link.send(400);
        }
    }

    if (!itemId) {
        return link.send(400);
    }

    /*
     *  pipeFile ()
     *
     *  This function checks if the file exists and pipes the result
     * */
    function pipeFile (doc, path) {
        // check if file exists
        fs.exists(path, function (exists) {

            if (!exists) {
                return link.send(404, " 404 file not found");
            }

            link.res.writeHead(200, {
                "Content-disposition": "filename=\"" + doc.fileName + "\""
            });

            var filestream = fs.createReadStream(path);
            filestream.pipe(link.res);
        });
    }

    getCollection(link.params.dsUpload, function (err, collection) {

        // handle error
        if (err) { return link.send(500, err); }

        // find and remove the item from db
        collection.findOne({ _id: ObjectId(itemId)}, function (err, doc) {

            // handle error
            if (err) { return link.send(500, err); }
            if (!doc) { return link.send(404, "item not found!"); }

            // handle files uploaded with template upload
            if (doc.template && doc.uploader) {
                if (!template || !uploader || doc.template !== template || doc.uploader !== uploader) { return link.send(400, "Bad uploader and/or template value!"); }

                // fetch template
                M.emit("crud.read", {
                    templateId: "000000000000000000000000",
                    role: link.session.crudRole,
                    query: {
                        _id: ObjectId(template)
                    },
                    noCursor: true
                }, function (err, template) {

                    if (err) {
                        return link.send(500, err);
                    }
                    if (!template[0]) {
                        return link.send(404, "Template not found");
                    }
                    template = template[0];

                    // check permissions
                    if (!template.options || !template.options.uploader || !template.options.uploader.uploaders) {
                        return link.send(400, "Bad uploader template configuration");
                    }
                    if (!Object.keys(template.options.uploader.uploaders).length) {
                        return link.send(400, "Bad uploader template configuration");
                    }

                    var uploaderConfig = template.options.uploader.uploaders[uploader];
                    if (!uploaderConfig || uploaderConfig.access.indexOf("d") === -1) {
                        return link.send(403, "Permission denied");
                    }

                    // finish the download
                    finishFileDownload({
                        doc: doc,
                        customPathHandler: uploaderConfig.customPathHandler
                    });
                });
            } else {
                // finish the download
                finishFileDownload({
                    doc: doc,
                    customPathHandler: link.params.customPathHandler
                });
            }
        });
    });

    function finishFileDownload (options) {

        // look for a path custom handler
        if (options.customPathHandler) {

            // call the handler
            M.emit(options.customPathHandler, {
                doc: options.doc,
                link: link,
            }, function (path) {

                // pipe the file
                pipeFile(options.doc, path);
            });
        } else {
            var path = M.app.getPath() + "/" + link.params.uploadDir + "/" + options.doc.filePath;

            // pipe the file
            pipeFile(options.doc, path);
        }
    }
}

/*
 *  remove operation
 *
 *  This is the remove operation which gets the id of a file and deletes it
 *
 * */
exports.remove = function (link) {

    if (!link.data && !link.query) {
        return;
    }

    // get the itemId
    var itemId, template, uploader;
    if (link.query.id) {
        itemId = link.query.id;
        template = link.query.template;
        uploader = link.query.uploader;
    } else if (link.data) {
        if (link.data.itemId) {
            itemId = link.data.itemId;
            template = link.data.template;
            uploader = link.data.uploader;
        } else {
            return link.send(400);
        }
    }

    if (!itemId) {
        return link.send(400);
    }

    getCollection(link.params.dsUpload, function (err, collection) {

        // handle error
        if (err) { return link.send(500, err); }

        // find and remove the item from db
        collection.findOne({ _id: ObjectId(itemId)}, function (err, doc) {

            // handle error
            if (err) { return link.send(500, err); }
            if (!doc) { return link.send(404, "item not found!"); }

            // handle files uploaded with template upload
            if (doc.template && doc.uploader) {
                if (!template || !uploader || doc.template !== template || doc.uploader !== uploader) { return link.send(400, "Bad uploader and/or template value!"); }

                // fetch template
                M.emit("crud.read", {
                    templateId: "000000000000000000000000",
                    role: link.session.crudRole,
                    query: {
                        _id: ObjectId(template)
                    },
                    noCursor: true
                }, function (err, template) {

                    if (err) {
                        return link.send(500, err);
                    }
                    if (!template[0]) {
                        return link.send(404, "Template not found");
                    }
                    template = template[0];

                    // check permissions
                    if (!template.options || !template.options.uploader || !template.options.uploader.uploaders) {
                        return link.send(400, "Bad uploader template configuration");
                    }
                    if (!Object.keys(template.options.uploader.uploaders).length) {
                        return link.send(400, "Bad uploader template configuration");
                    }

                    var uploaderConfig = template.options.uploader.uploaders[uploader];
                    if (!uploaderConfig || uploaderConfig.access.indexOf("r") === -1) {
                        return link.send(403, "Permission denied");
                    }

                    // finish the remove operation
                    finishFileRemove({
                        removeFileEvent: link.params.removeFileEvent,
                        doc: doc
                    });
                });
            } else {
                // finish the remove operation
                finishFileRemove({
                    removeFileEvent: link.params.removeFileEvent,
                    doc: doc
                });
            }
        });
    });

    function finishFileRemove (options) {
        // check if a custom handler exists
        if (options.removeFileEvent) {
            // call the handler
            M.emit(options.removeFileEvent, {
                link: link
            }, function (err) {

                if (err) { return link.send(400, err); }

                // remove file
                removeFile(link, options.doc, function (err) {

                    // handle error
                    if (err) {
                        if (err === "NOT_FOUND") {
                            return link.send(404, "File not found!");
                        } else if (err === "BAD_REQUEST") {
                            return link.send(400, "Bad request!");
                        } else {
                            return link.send(500, err);
                        }
                    }

                    // all done
                    link.send(200);
                });
            });
        } else {
            // remove file
            removeFile(link, options.doc, function (err) {

                // handle error
                if (err) {
                    if (err === "NOT_FOUND") {
                        return link.send(404, "File not found!");
                    } else if (err === "BAD_REQUEST") {
                        return link.send(400, "Bad request!");
                    } else {
                        return link.send(500, err);
                    }
                }

                // all done
                link.send(200);
            });
        }
    }
}

// private functions

/*
 *  removedFile (link, doc, function)
 *
 *  This removes a document form a collection and then deletes it
 *  from the upload dir
 * */
function removeFile (link, doc, callback) {

    getCollection(link.params.dsUpload, function (err, collection) {

        // handle error
        if (err) { return callback(err); }

        // find and remove the item from db
        collection.remove({ _id: ObjectId(doc._id)}, function (err) {

            // handle error
            if (err) { return callback(err); }

            var path = M.app.getPath() + "/" + link.params.uploadDir + "/" + doc.filePath;

            // delete the item
            fs.unlink(path, function (err) {

                // handle error;
                if (err) { return callback("BAD_REQUEST"); }

                callback(null);
            });
        });
    });
}

/*
 *  getCollection (string, function)
 *
 *  This returns the collection object as the second argument in the
 *  callback function or an error as first argument
 * */
function getCollection (paramsDs, callback) {
    M.datasource.resolve(paramsDs, function(err, ds) {
        if (err) { return callback(400, err); }

        M.database.open(ds, function(err, db) {
            if (err) { return callback(400, err); }

            db.collection(ds.collection, function(err, collection) {
                if (err) { return callback(400, err); }

                callback(null, collection);
            });
        });
    });
}

/*
 *  This function looks for a custom handler to get the upload dir
 *
 *  Arguments
 *    @options: object containing:
 *      - uploadDir
 *      - customUpload
 *      - data
 *      - link
 *    @callback: the callback function
 * */
function getUploadDir (options, callback) {

    var relativeUploadDir = options.uploadDir;

    // default behavior? (not a custom upload dir handler event)
    if (!options.customUpload) {
        var uploadDir = M.app.getPath() + "/" + options.uploadDir;
        return callback(null, uploadDir, relativeUploadDir);
    }

    // there is a customUpload handler event
    M.emit(options.customUpload, { data: options.data, link: options.link }, function (customDir) {

        customDir = customDir || "";
        var customDirs = customDir.split("/");
        var uploadDir = M.app.getPath() + "/" + options.uploadDir;
        var DIRS_TO_CREATE = customDirs.length;

        if (!DIRS_TO_CREATE) {
            return callback(null, uploadDir, customDir, relativeUploadDir);
        }

        for (var i in customDirs) {
            uploadDir += "/" + customDirs[i];

            // create the directory
            fs.mkdir(uploadDir, function (err) {
                // handle error
                // TODO - what if a file exists with the name of a folder?
                //      - replace this with a library
                if (err && err.code !== "EEXIST") { return callback(err); }

                if (!--DIRS_TO_CREATE) {
                    relativeUploadDir += "/" + customDir;
                    callback(null, uploadDir, customDir, relativeUploadDir);
                }
            });
        }
    });
}

/*
 *  This function checks if the selected file has a correct
 *  extension (self.config.options.acceptTypes)
 * */
function checkFileType (ext, supportedExts) {

    ext = ext.replace(".", "");

    // the extension is not supported
    if (supportedExts.indexOf(ext) === -1) {
        return false;
    }

    // the extension is supported
    return true;
}
