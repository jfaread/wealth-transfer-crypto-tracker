const {existsSync}=require('node:fs');
module.exports=function browserLaunchOptions(){
 const configured=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
 if(configured)return {executablePath:configured,headless:true};
 if(existsSync('/usr/bin/chromium'))return {executablePath:'/usr/bin/chromium',headless:true};
 return {channel:'chrome',headless:true};
};
