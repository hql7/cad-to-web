//
// Copyright (c) Autodesk, Inc. All rights reserved
//
// Permission to use, copy, modify, and distribute this software in
// object code form for any purpose and without fee is hereby granted,
// provided that the above copyright notice appears in all copies and
// that both that copyright notice and the limited warranty and
// restricted rights notice below appear in all supporting
// documentation.
//
// AUTODESK PROVIDES THIS PROGRAM "AS IS" AND WITH ALL FAULTS.
// AUTODESK SPECIFICALLY DISCLAIMS ANY IMPLIED WARRANTY OF
// MERCHANTABILITY OR FITNESS FOR A PARTICULAR USE.  AUTODESK, INC.
// DOES NOT WARRANT THAT THE OPERATION OF THE PROGRAM WILL BE
// UNINTERRUPTED OR ERROR FREE.
//
// Forge Extractor
// by Cyrille Fauvel - Autodesk Developer Network (ADN)
//
var express =require ('express') ;
var bodyParser =require ('body-parser') ;
var fs =require ('fs') ;
var path =require ('path') ;

var ForgeSDK =require ('forge-apis') ;
var config =require ('./config') ;
var utils =require ('./utils') ;
var Bubble =require ('./bubble') ;
var forgeToken =require ('./forge-token') ;

var router =express.Router () ;
router.use (bodyParser.json ()) ;

router.get ('/test', function (req, res) {
	res.json (req.headers) ;
}) ;

// List translated projects
router.get ('/results', function (req, res) {
	// Protect the endpoint from external usage.
	if ( !utils.checkHost (req, config.domain) )
		return (res.status (403). end ()) ;

	utils.readdir (utils.path ('data'))
		.then (function (files) {
			files =filterProject (files, '(.*)\\.resultdb\\.json') ;
			var promises =files.map (getLocalManifest) ;
			return (Promise.all (promises)) ;
		})
		.then (function (manifests) {
			for ( var i =0 ; i < manifests.length ; i++ ) {
				var manifest =manifests [i] ;
				//manifest.name =decodeURI (utils.safeBase64decode (manifest.urn).replace (/^.*\//, '')) ;
				//utils.writeFile (utils.data (manifest.key + '.resultdb'), manifest)
				//	.then (function (content) {
				//		// Pull the thumbnail if it does not exists yet, and do not wait
				//		downloadThumbnail (content.key) ;
				//	})
				//;

				// Pull the thumbnail if it does not exists yet, and do not wait
				if ( manifest.hasThumbnail === "true" )
					downloadThumbnail (manifest.key) ;
			}
			res.json (manifests) ;
		})
		.catch (function (err) {
			res.status (404).send () ;
		})
	;
}) ;

var filterProject =function  (arr, criteria) {
	var filtered =arr.filter (function (obj) { return (new RegExp (criteria).test (obj)) ; }) ;
	var results =[] ;
	for ( var index =0 ; index < filtered.length ; index++ )
		results.push (new RegExp (criteria).exec (filtered [index]) [1]) ;
	return (results) ;
} ;

var getLocalFileDescriptor =function (identifier) {
	return (utils.json (identifier)
		.then (function (json) {
			return (json) ;
		})
		.catch (function (error) {
			console.log (error) ;
		})
	) ;
} ;

var getLocalManifest =function (identifier) {
	return (utils.json (identifier + '.resultdb')
		.then (function (json) {
			return (json) ;
		})
		.catch (function (error) {
			console.log (error) ;
		})
	) ;
} ;

// Download the thumbnail
router.get ('/results/:identifier/thumbnail', function (req, res) {
	// Protect the endpoint from external usage.
	if ( !utils.checkHost (req, config.domain) )
		return (res.status (403). end ()) ;

	var identifier =req.params.identifier ;
	var png =utils.extracted (identifier + '.png') ;
	utils.filesize (png)
		.then (function (info) {
			res.writeHead (200, {
				'Content-Type': 'image/png',
				'Content-Length': info
			}) ;
			fs.createReadStream (png)
				.pipe (res) ;
		})
		.catch (function (error) {
			utils.json (identifier + '.resultdb')
				.then (function (json) {
					if ( json.hasThumbnail === 'false' )
						throw new Error ('No thumbnail') ;
					var ModelDerivative =new ForgeSDK.DerivativesApi () ;
					return (ModelDerivative.getThumbnail (json.urn, { width: 200, height: 200 }, forgeToken.RW, forgeToken.RW.getCredentials ())) ;
				})
				.then (function (thumbnail) {
					fs.writeFile (png, thumbnail.body) ;
					res.setHeader ('Content-Type', thumbnail.headers ['content-type']) ;
					res.end (thumbnail.body, 'binary') ;
				})
				.catch (function (error) {
					res.status (404).end () ;
				})
			;
		})
	;
}) ;

var downloadThumbnail =function (identifier) {
	var png =utils.extracted (identifier + '.png') ;
	utils.filesize (png)
		.then (function (info) {
			// All good, we have it already
		})
		.catch (function (error) {
			utils.json (identifier + '.resultdb')
				.then (function (json) {
					if ( json.hasThumbnail === 'false' )
						throw new Error ('No thumbnail') ;
					var ModelDerivative =new ForgeSDK.DerivativesApi () ;
					return (ModelDerivative.getThumbnail (json.urn, { width: 200, height: 200 }, forgeToken.RW, forgeToken.RW.getCredentials ())) ;
				})
				.then (function (thumbnail) {
					fs.writeFile (png, thumbnail.body, function (err) {}) ;
					console.log ('written to disk', png) ;
				})
				.catch (function (error) {
					console.error (error, png) ;
					fs.createReadStream (utils.path ('www/images/project-sheet.png'))
						.pipe (fs.createWriteStream (utils.extracted (identifier + '.png'))) ;
				})
			;
		})
	;
} ;

// Download viewable data as a zip file containing all resources
var _locks ={} ;
var _progress ={} ;
router.get ('/results/:identifier/project', function (req, res) {
	// Protect the endpoint from external usage.
	if ( !utils.checkHost (req, config.domain) )
		return (res.status (403). end ()) ;

	var identifier =req.params.identifier ;
	var sqllite =req.query.sqllite ;
	var viewer_files =req.query.viewer_files ;
	var zip_filename =identifier + '.zip' ;
	var zip_sqllite = identifier + '-db.zip';
	var urn ='', manifest ='' ;
	utils.fileexists (utils.extracted (zip_filename))
		.then (function (bExists) {
			if ( bExists )
				throw new Error ('Bubble already extracted!') ;
			// Are we already extracting?
			var bExtractionRunning =_locks.hasOwnProperty (identifier) ;
			if ( !bExtractionRunning )
				_locks [identifier] =[] ;
			if ( req.query.email && req.query.email !== '' )
				_locks [identifier].push (req.query.email) ;
			if ( bExtractionRunning )
				throw new Error ('Bubble already being extracted!') ;

			_progress [identifier] ={ _filesToFetch: 0, _estimatedSize: 0, _progress: 0, msg: 'Initializing' } ;
			return (utils.json (identifier + '.resultdb')) ;
		})
		.then (function (json) {
			if ( !json.hasOwnProperty ('urn') )
				throw new Error ('No URN') ;
			// Ok, we return a 200 HTTP code to the browser and we continue the extraction
			res.status (200).end () ;
			for ( var i =0 ; i < json.derivatives.length ; i++ ) {
				if ( json.derivatives [i].outputType === 'svf' ) {
					manifest =json.derivatives [i] ;
					break ;
				}
			}
			urn =json.urn ;
			return (utils.rimraf (utils.path ('data/' + identifier))) ; // Just to make sure
		})
		.then (function (pathname) {
			var b =new Bubble.bubble (_progress [identifier]) ;
			return (b.downloadBubble (urn, pathname + '/')) ;
		})
		.then (function (bubble) {
			//if ( viewer_files != 'true' )
			//	return (bubble) ;
			// Generate local html, and bat/sh files
			_progress [identifier].msg ='Generating local html, and bat/sh files' ;
			return (Bubble.utils.GenerateStartupFiles (bubble, identifier)) ;
		})
		// .then (function (bubble) {
		// 	if ( viewer_files != 'true' )
		// 		return (bubble) ;
		// 	// Get Viewer files and dependencies
		// 	_progress [identifier].msg ='Downloading latest Forge Viewer version (core and dependencies)' ;
		// 	return (Bubble.utils.AddViewerFiles (bubble, identifier)) ;
		// })
		.then (function (bubble) {
			_progress [identifier].msg ='Preparing sqllite db ZIP file' ;
			var inDir =utils.path ('data/' + identifier + '/') ;
			var outZip =utils.extracted (zip_sqllite) ;
			return (Bubble.utils.PackSqllite (inDir, outZip)) ;
		})
		.then (function (bubble) {
			_progress [identifier].msg ='Preparing bubble ZIP file' ;
			var inDir =utils.path ('data/' + identifier + '/') ;
			var outZip =utils.extracted (zip_filename) ;
			return (Bubble.utils.PackBubble (inDir, outZip)) ;
		})
		.then (function (outZipFilename) {
			_progress [identifier].msg ='Cleaning workspace and notifying listeners' ;
			Bubble.utils.NotifyPeopleOfSuccess (identifier, sqllite, viewer_files, _locks [identifier])
				.then (function () {
					delete _locks [identifier] ;
					delete _progress [identifier] ;
				}) ;
			return (utils.rimraf (utils.path ('data/' + identifier))) ;
		})
		.catch (function (error) {
			if (_progress [identifier] !== undefined )
				_progress [identifier].msg =error.message ;
			if ( error.message == 'Bubble already extracted!' || error.message == 'Bubble already being extracted!' )
				return (res.status (200).end (error.message)) ;
			utils.rimraf (utils.path ('data/' + identifier)) ;
			Bubble.utils.NotifyPeopleOfFailure (identifier, _locks [identifier], error)
				.then (function () {
					delete _locks [identifier] ;
					delete _progress [identifier] ;
				}) ;
			return (res.status (500).end (error.message)) ;
		})
	;
}) ;

// Get viewable data extraction progress
router.get ('/results/:identifier/project/progress', function (req, res) {
	var identifier =req.params.identifier ;
	res.json (_progress [identifier] || { _progress: 100, msg: 'Completed' }) ;
}) ;

// Delete the project from the website
router.get ('/results/:identifier/delete', function (req, res) {
	// Protect the endpoint from external usage.
	if ( !utils.checkHost (req, config.domain) )
		return (res.status (403). end ()) ;

	DeleteData (req, res) ;
}) ;

router.delete ('/results/:identifier', function (req, res) {
	// Protect the endpoint from external usage.
	if ( !utils.checkHost (req, config.domain) )
		return (res.status (403). end ()) ;

	DeleteData (req, res) ;
}) ;

function DeleteData (req, res) {
	var bucket =config.bucket ;
	var identifier =req.params.identifier ;
	if ( identifier === 'all' )
		return (deleteAll (res)) ;
	utils.json (identifier + '.resultdb')
		.then (function (json) {
			utils.unlink (utils.extracted (identifier + '.png')) ;
			utils.unlink (utils.extracted (identifier + '.zip')) ;
			getLocalManifest (identifier)
				.then (function (content) {
					var ModelDerivative =new ForgeSDK.DerivativesApi () ;
					ModelDerivative.deleteManifest (content.urn, forgeToken.RW, forgeToken.RW.getCredentials ())
						.catch (function (error) {
							console.error ('Error:' + error) ;
						}) ;
					utils.unlink (utils.data (this.identifier + '.resultdb')) ;
					utils.unlink (utils.data (this.identifier + '.job')) ;
					return (getLocalFileDescriptor (this.identifier)) ;
				}.bind ({ identifier: identifier }))
				.then (function (desc) {
					var ObjectsApi =new ForgeSDK.ObjectsApi () ;
					ObjectsApi.deleteObject (bucket, desc.objectKey, forgeToken.RW, forgeToken.RW.getCredentials ())
						.catch (function (error) {
							console.error ('Error:' + error) ;
						}) ;
					utils.unlink (utils.data (this.identifier)) ;
					console.log (this.identifier + " project deleted!") ;
					res.end () ;
				}.bind ({ identifier: identifier }))
				.catch (function (err) {
					console.error ('Error:' + err) ;
					res.status (500).end (err) ;
				})
			;
		})
		.catch (function (error) {
			console.error ('Error:' + error) ;
			res.status (404).end () ;
		})
	;
}

// Delete all projects from the website
var deleteAll =function (res) {
	var bucket =config.bucket ;
	utils.readdir (utils.path ('data'))
		.then (function (files) {
			files =filterProject (files, '(.*)\\.resultdb\\.json') ;
			var promises =files.map (getLocalManifest) ;
			return (Promise.all (promises)) ;
		})
		.then (function (manifests) {
			for ( var i =0 ; i < manifests.length ; i++ ) {
				var manifest =manifests [i] ;
				var identifier =manifest.key ;
				utils.unlink (utils.extracted (identifier + '.png')) ;
				utils.unlink (utils.extracted (identifier + '.zip')) ;
				getLocalManifest (identifier)
					.then (function (content) {
						var ModelDerivative =new ForgeSDK.DerivativesApi () ;
						ModelDerivative.deleteManifest (content.urn, forgeToken.RW, forgeToken.RW.getCredentials ()) ;
						utils.unlink (utils.data (this.identifier + '.resultdb')) ;
						utils.unlink (utils.data (this.identifier + '.job')) ;
						return (getLocalFileDescriptor (this.identifier)) ;
					}.bind ({ identifier: identifier }))
					.then (function (desc) {
						var ObjectsApi =new ForgeSDK.ObjectsApi () ;
						ObjectsApi.deleteObject (bucket, desc.objectKey, forgeToken.RW, forgeToken.RW.getCredentials ()) ;
						utils.unlink (utils.data (this.identifier)) ;
						console.log (this.identifier + " project deleted!") ;
					}.bind ({ identifier: identifier }))
					.catch (function (err) {
						console.log (err) ;
					})
				;
			}
			res.end () ;
		})
		.catch (function (err) {
			res.status (500).send () ;
		})
	;
} ;

// Report status
router.get ('/results/status', function (req, res) {
	// Protect the endpoint from external usage.
	if ( !utils.checkHost (req, config.domain) )
		return (res.status (403). end ()) ;

	utils.readdir (utils.path ('data'))
		.then (function (files) {
			files =files.filter (function (f) { return (/.*\.resultdb\.json$/.test (f)) ; }) ;
			//console.log (files) ;

			var promises =files.map (function (f) {
				return (new Promise (function (fulfill, reject) {
					var json ={
						id: f.match (/^(.*)\.resultdb\.json$/) [1],
						status: '?',
						urn: '?'
					} ;
					utils.readFile (utils.path ('data/' + f))
						.then (function (content) {
							content =JSON.parse (content.toString ('utf-8')) ;
							var ModelDerivative =new ForgeSDK.DerivativesApi () ;
							return (ModelDerivative.getManifest (content.urn, {}, forgeToken.RW, forgeToken.RW.getCredentials ())) ;
						})
						.then (function (manifest) {
							//console.log (manifest) ;
							manifest =manifest.body ;
							json.status =(manifest.status === 'failed' || manifest.status === 'timeout' ? 'failed' : manifest.status) ;
							json.urn =manifest.urn ;
							fulfill (json) ;
						})
						.catch (function (error) {
							json.status ='failed' ;
							fulfill (json) ;
						})
					;
				})) ;
			}) ;
			return (Promise.all (promises)) ;
		})
		.then (function (ps) {
			for ( var i =0 ; i < ps.length ; i++ ) {
				if ( ps [i].status === 'failed' ) {
					utils.unlink (utils.data (ps [i].id + '.resultdb')) ;
					utils.unlink (utils.data (ps [i].id + '.job')) ;
					utils.unlink (utils.extracted (ps [i].id + '.png')) ;
				}
			}
			res.json (ps) ;
		})
		.catch (function (error) {
			console.error (error) ;
			res.status (500).end () ;
		})
	;
	//res.end () ;
}) ;

module.exports =router ;
